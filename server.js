import express from "express";
import cors from "cors";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "path";
import fs from "fs";
import net from "net";
import { fileURLToPath } from "url";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const frontendPath=path.resolve(__dirname,"../public");
if(fs.existsSync(frontendPath)) app.use(express.static(frontendPath));
app.use(cors());
app.use(express.json());

const PORT=process.env.PORT||5000;
const SECRET=process.env.JWT_SECRET||"CHANGE_ME_BEFORE_PRODUCTION";
const dbPath=process.env.DB_FILE||"/var/data/star_communication.db";
const db=new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS admins(
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL, role TEXT DEFAULT 'admin', created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS packages(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, speed TEXT,
 monthly_price REAL NOT NULL DEFAULT 0, status TEXT DEFAULT 'Active'
);
CREATE TABLE IF NOT EXISTS customers(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT NOT NULL,
 address TEXT, package_id INTEGER, monthly_bill REAL DEFAULT 0,
 payment_status TEXT DEFAULT 'Unpaid', service_status TEXT DEFAULT 'Active',
 expiry_date TEXT, due REAL DEFAULT 0, previous_due REAL DEFAULT 0,
 pppoe_username TEXT UNIQUE, pppoe_password TEXT,
 mikrotik_device_id INTEGER, olt_device_id INTEGER, pon_port TEXT,
 onu_serial TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments(
 id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL,
 amount REAL NOT NULL, payment_date TEXT NOT NULL, method TEXT,
 new_expiry_date TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS incomes(
 id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, amount REAL NOT NULL,
 income_date TEXT NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS expenses(
 id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, amount REAL NOT NULL,
 expense_date TEXT NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS mikrotik_devices(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL,
 api_port INTEGER DEFAULT 8728, username TEXT, password_encrypted TEXT, status TEXT DEFAULT 'Not Connected'
);
CREATE TABLE IF NOT EXISTS olt_devices(
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, brand TEXT,
 host TEXT, username TEXT, password_encrypted TEXT, status TEXT DEFAULT 'Not Connected'
);
`);

const admin=db.prepare("SELECT * FROM admins WHERE username=?").get(process.env.ADMIN_USERNAME||"admin");
if(!admin){
 const hash=bcrypt.hashSync(process.env.ADMIN_PASSWORD||"change-me",10);
 db.prepare("INSERT INTO admins(username,password_hash) VALUES(?,?)").run(process.env.ADMIN_USERNAME||"admin",hash);
}

function auth(req,res,next){
 const h=req.headers.authorization||"";
 const token=h.startsWith("Bearer ")?h.slice(7):null;
 if(!token)return res.status(401).json({error:"Unauthorized"});
 try{req.user=jwt.verify(token,SECRET);next()}catch{return res.status(401).json({error:"Invalid token"})}
}
function customer(id){return db.prepare("SELECT * FROM customers WHERE id=?").get(id)}

app.get("/api/health",(req,res)=>res.json({ok:true,app:"STAR COMMUNICATION ISP ADMIN PRO V19",time:new Date().toISOString()}));
app.get("/api/monitoring",auth,(req,res)=>{
 const one=(sql)=>db.prepare(sql).get();
 const customers=one("SELECT COUNT(*) count FROM customers").count;
 const paid=one("SELECT COUNT(*) count FROM customers WHERE payment_status=\"Paid\"").count;
 const unpaid=one("SELECT COUNT(*) count FROM customers WHERE payment_status=\"Unpaid\"").count;
 const expired=one("SELECT COUNT(*) count FROM customers WHERE payment_status=\"Expired\"").count;
 const inactive=one("SELECT COUNT(*) count FROM customers WHERE service_status=\"Inactive\"").count;
 const collection=one("SELECT COALESCE(SUM(amount),0) total FROM payments").total;
 const income=one("SELECT COALESCE(SUM(amount),0) total FROM incomes").total;
 const expense=one("SELECT COALESCE(SUM(amount),0) total FROM expenses").total;
 const mikrotik=one("SELECT COUNT(*) count FROM mikrotik_devices").count;
 const olt=one("SELECT COUNT(*) count FROM olt_devices").count;
 res.json({server:true,customers,paid,unpaid,expired,inactive,collection,income,expense,profit:collection+income-expense,mikrotik,olt,checked_at:new Date().toISOString()});
});
app.get("/",(req,res)=>{ const f=path.join(frontendPath,"index.html"); if(fs.existsSync(f)) return res.sendFile(f); res.json({ok:true,app:"STAR COMMUNICATION V16 API",status:"Online"}); });

app.post("/api/auth/login",(req,res)=>{
 const {username,password}=req.body;
 const user=db.prepare("SELECT * FROM admins WHERE username=?").get(username);
 if(!user||!bcrypt.compareSync(password||"",user.password_hash)) return res.status(401).json({error:"Invalid username or password"});
 const token=jwt.sign({id:user.id,username:user.username,role:user.role},SECRET,{expiresIn:"12h"});
 res.json({token,user:{id:user.id,username:user.username,role:user.role}});
});

app.get("/api/dashboard",auth,(req,res)=>{
 const one=(sql)=>db.prepare(sql).get();
 const total=one("SELECT COUNT(*) count FROM customers").count;
 const paid=one("SELECT COUNT(*) count FROM customers WHERE payment_status='Paid'").count;
 const unpaid=one("SELECT COUNT(*) count FROM customers WHERE payment_status='Unpaid'").count;
 const expired=one("SELECT COUNT(*) count FROM customers WHERE payment_status='Expired'").count;
 const inactive=one("SELECT COUNT(*) count FROM customers WHERE service_status='Inactive'").count;
 const collection=one("SELECT COALESCE(SUM(amount),0) total FROM payments").total;
 const income=one("SELECT COALESCE(SUM(amount),0) total FROM incomes").total;
 const expense=one("SELECT COALESCE(SUM(amount),0) total FROM expenses").total;
 const due=one("SELECT COALESCE(SUM(due+previous_due),0) total FROM customers").total;
 res.json({total_clients:total,paid,unpaid,expired,inactive,bill_collection:collection,income,expense,net_profit:collection+income-expense,total_due:due});
});

app.get("/api/customers",auth,(req,res)=>{
 const q=(req.query.q||"").trim();
 const status=req.query.status;
 let sql="SELECT * FROM customers WHERE 1=1", params=[];
 if(status){sql+=" AND payment_status=?";params.push(status)}
 if(q){sql+=" AND (name LIKE ? OR phone LIKE ? OR address LIKE ? OR pppoe_username LIKE ?)"; for(let i=0;i<4;i++)params.push(`%${q}%`)}
 res.json(db.prepare(sql+" ORDER BY id DESC").all(...params));
});
app.post("/api/customers",auth,(req,res)=>{
 const x=req.body;
 const info=db.prepare(`INSERT INTO customers(name,phone,address,package_id,monthly_bill,payment_status,service_status,expiry_date,due,previous_due,pppoe_username,pppoe_password,mikrotik_device_id,olt_device_id,pon_port,onu_serial)
 VALUES(@name,@phone,@address,@package_id,@monthly_bill,@payment_status,@service_status,@expiry_date,@due,@previous_due,@pppoe_username,@pppoe_password,@mikrotik_device_id,@olt_device_id,@pon_port,@onu_serial)`)
 .run({name:x.name,phone:x.phone,address:x.address||"",package_id:x.package_id||null,monthly_bill:x.monthly_bill||0,payment_status:x.payment_status||"Unpaid",service_status:x.service_status||"Active",expiry_date:x.expiry_date||null,due:x.due||x.monthly_bill||0,previous_due:x.previous_due||0,pppoe_username:x.pppoe_username||null,pppoe_password:x.pppoe_password||null,mikrotik_device_id:x.mikrotik_device_id||null,olt_device_id:x.olt_device_id||null,pon_port:x.pon_port||null,onu_serial:x.onu_serial||null});
 res.status(201).json(customer(info.lastInsertRowid));
});
app.get("/api/customers/:id",auth,(req,res)=>{const x=customer(req.params.id);x?res.json(x):res.status(404).json({error:"Not found"})});
app.delete("/api/customers/:id",auth,(req,res)=>{const x=customer(req.params.id);if(!x)return res.status(404).json({error:"Not found"});db.prepare("DELETE FROM payments WHERE customer_id=?").run(req.params.id);db.prepare("DELETE FROM customers WHERE id=?").run(req.params.id);res.json({ok:true})});
app.put("/api/customers/:id",auth,(req,res)=>{
 const old=customer(req.params.id);if(!old)return res.status(404).json({error:"Not found"});
 const x={...old,...req.body,id:old.id};
 db.prepare(`UPDATE customers SET name=@name,phone=@phone,address=@address,monthly_bill=@monthly_bill,payment_status=@payment_status,service_status=@service_status,expiry_date=@expiry_date,due=@due,previous_due=@previous_due,pppoe_username=@pppoe_username,pppoe_password=@pppoe_password,pon_port=@pon_port,onu_serial=@onu_serial WHERE id=@id`).run(x);
 res.json(customer(old.id));
});
app.post("/api/customers/:id/service",auth,(req,res)=>{
 const status=req.body.status==="Inactive"?"Inactive":"Active";
 db.prepare("UPDATE customers SET service_status=? WHERE id=?").run(status,req.params.id);
 res.json(customer(req.params.id));
});

app.post("/api/customers/:id/payment",auth,(req,res)=>{
 const x=customer(req.params.id);if(!x)return res.status(404).json({error:"Not found"});
 const amount=Number(req.body.amount||0);if(amount<=0)return res.status(400).json({error:"Amount required"});
 const totalDue=Number(x.due||0)+Number(x.previous_due||0);
 const remaining=Math.max(0,totalDue-amount);
 const date=req.body.payment_date||new Date().toISOString().slice(0,10);
 const expiry=req.body.new_expiry_date||x.expiry_date;
 db.prepare("INSERT INTO payments(customer_id,amount,payment_date,method,new_expiry_date,note) VALUES(?,?,?,?,?,?)")
 .run(x.id,amount,date,req.body.method||"Cash",expiry,req.body.note||"");
 db.prepare("UPDATE customers SET due=?,previous_due=0,payment_status=?,expiry_date=? WHERE id=?")
 .run(remaining,remaining===0?"Paid":"Unpaid",expiry,x.id);
 res.json({customer:customer(x.id),message:"Payment saved"});
});

app.get("/api/payments",auth,(req,res)=>res.json(db.prepare(`SELECT p.*,c.name,c.phone,c.address FROM payments p JOIN customers c ON c.id=p.customer_id ORDER BY p.id DESC`).all()));

function simpleResource(name, table, fields, dateField){
 app.get(`/api/${name}`,auth,(req,res)=>res.json(db.prepare(`SELECT * FROM ${table} ORDER BY id DESC`).all()));
 app.post(`/api/${name}`,auth,(req,res)=>{
   const x=req.body; const cols=fields.join(","); const marks=fields.map(f=>"@"+f).join(",");
   const info=db.prepare(`INSERT INTO ${table}(${cols}) VALUES(${marks})`).run(x);
   res.status(201).json(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(info.lastInsertRowid));
 });
}
simpleResource("income","incomes",["source","amount","income_date","note"]);
simpleResource("expenses","expenses",["category","amount","expense_date","note"]);


function devicePortTest(host,port,timeout=4000){
 return new Promise((resolve)=>{
  if(!host)return resolve(false);
  const socket=net.createConnection({host,port:Number(port)},()=>{socket.destroy();resolve(true)});
  socket.setTimeout(timeout,()=>{socket.destroy();resolve(false)});
  socket.on("error",()=>resolve(false));
 });
}
app.post("/api/network/mikrotik",auth,(req,res)=>{
 const x=req.body||{}; if(!x.name||!x.host)return res.status(400).json({error:"Name and host are required"});
 const info=db.prepare("INSERT INTO mikrotik_devices(name,host,api_port,username,password_encrypted,status) VALUES(?,?,?,?,?,?)").run(x.name,x.host,Number(x.api_port||8728),x.username||"",x.password||"","Not Connected");
 res.status(201).json(db.prepare("SELECT id,name,host,api_port,status FROM mikrotik_devices WHERE id=?").get(info.lastInsertRowid));
});
app.delete("/api/network/mikrotik/:id",auth,(req,res)=>{db.prepare("DELETE FROM mikrotik_devices WHERE id=?").run(req.params.id);res.json({ok:true})});
app.post("/api/network/mikrotik/:id/test",auth,async(req,res)=>{
 const x=db.prepare("SELECT * FROM mikrotik_devices WHERE id=?").get(req.params.id); if(!x)return res.status(404).json({error:"Device not found"});
 const ok=await devicePortTest(x.host,x.api_port||8728); db.prepare("UPDATE mikrotik_devices SET status=? WHERE id=?").run(ok?"Connected":"Not Connected",x.id);
 res.json({ok,status:ok?"Connected":"Not Connected",message:ok?"MikroTik port is reachable":"MikroTik port is not reachable"});
});
app.post("/api/network/olt",auth,(req,res)=>{
 const x=req.body||{}; if(!x.name||!x.host)return res.status(400).json({error:"Name and host are required"});
 const info=db.prepare("INSERT INTO olt_devices(name,brand,host,username,password_encrypted,status) VALUES(?,?,?,?,?,?)").run(x.name,x.brand||"V-SOL",x.host,x.username||"",x.password||"","Not Connected");
 res.status(201).json(db.prepare("SELECT id,name,brand,host,status FROM olt_devices WHERE id=?").get(info.lastInsertRowid));
});
app.delete("/api/network/olt/:id",auth,(req,res)=>{db.prepare("DELETE FROM olt_devices WHERE id=?").run(req.params.id);res.json({ok:true})});
app.post("/api/network/olt/:id/test",auth,async(req,res)=>{
 const x=db.prepare("SELECT * FROM olt_devices WHERE id=?").get(req.params.id); if(!x)return res.status(404).json({error:"Device not found"});
 let ok=await devicePortTest(x.host,443); if(!ok)ok=await devicePortTest(x.host,80); if(!ok)ok=await devicePortTest(x.host,23);
 db.prepare("UPDATE olt_devices SET status=? WHERE id=?").run(ok?"Connected":"Not Connected",x.id);
 res.json({ok,status:ok?"Connected":"Not Connected",message:ok?"OLT network port is reachable":"OLT ports 443/80/23 are not reachable"});
});
app.get("/api/network/devices",auth,(req,res)=>res.json({
 mikrotik:db.prepare("SELECT id,name,host,api_port,status FROM mikrotik_devices").all(),
 olt:db.prepare("SELECT id,name,brand,host,status FROM olt_devices").all()
}));

app.listen(PORT,()=>console.log(`STAR COMMUNICATION V13 API running on http://localhost:${PORT}`));
