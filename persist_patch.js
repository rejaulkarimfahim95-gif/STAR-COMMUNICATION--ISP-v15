// STAR COMMUNICATION V18 - Permanent server storage patch
(function(){
  const oldSync=window.syncFromBackend;
  function isBackend(){return !!(window.TOKEN && window.API);}
  async function saveAndRefresh(){ await syncFromBackend(); }
  window.saveCustomer=async function(){
    let n=document.getElementById('n').value.trim(),ph=document.getElementById('ph').value.trim(),ad=document.getElementById('ad').value.trim(),pk=document.getElementById('pk').value,pr=Number(document.getElementById('pr').value);
    if(!n||!ph||!ad||!pr){alert('Please fill all required fields');return}
    if(!isBackend()){db.customers.push({id:Date.now(),name:n,phone:ph,address:ad,pkg:pk,price:pr,service:'Active',payment:'Unpaid',expiry:'Not set',due:pr,previousDue:0,createdAt:new Date().toISOString().slice(0,10)});save();closeModal();go('customers');return}
    try{await api('/customers',{method:'POST',body:JSON.stringify({name:n,phone:ph,address:ad,package_id:null,monthly_bill:pr,payment_status:'Unpaid',service_status:'Active',due:pr,previous_due:0})});closeModal();await saveAndRefresh();go('customers');alert('Customer saved permanently to server.');}catch(e){alert('Save failed: '+e.message)}
  };
  window.saveEdit=async function(id){
    let x=db.customers.find(z=>z.id===id);if(!x)return;
    let n=document.getElementById('en').value.trim(),ph=document.getElementById('eph').value.trim(),ad=document.getElementById('ead').value.trim(),pk=document.getElementById('epk').value.trim(),pr=Number(document.getElementById('epr').value),ex=document.getElementById('eex').value;
    if(!n||!ph||!ad||!pk||!pr){alert('Please complete all required fields');return}
    if(!isBackend()){Object.assign(x,{name:n,phone:ph,address:ad,pkg:pk,price:pr,service:document.getElementById('esv').value});if(ex)x.expiry=ex;save();closeModal();render();return}
    try{await api('/customers/'+id,{method:'PUT',body:JSON.stringify({name:n,phone:ph,address:ad,monthly_bill:pr,service_status:document.getElementById('esv').value,expiry_date:ex||null})});closeModal();await saveAndRefresh();go('customers');alert('Customer updated permanently.');}catch(e){alert('Update failed: '+e.message)}
  };
  window.deleteCustomer=async function(id){
    let x=db.customers.find(z=>z.id===id);if(!x)return;if(!confirm(`Delete ${x.name}? This action cannot be undone.`))return;
    if(!isBackend()){db.customers=db.customers.filter(z=>z.id!==id);db.payments=db.payments.filter(z=>z.customerId!==id);save();closeModal();render();return}
    try{await api('/customers/'+id,{method:'DELETE'});closeModal();await saveAndRefresh();go('customers');alert('Customer deleted permanently from server.');}catch(e){alert('Delete failed: '+e.message)}
  };
  window.toggleService=async function(id){
    let x=db.customers.find(z=>z.id===id);if(!x)return;let status=x.service==='Inactive'?'Active':'Inactive';
    if(!isBackend()){x.service=status;save();render();return}
    try{await api('/customers/'+id+'/service',{method:'POST',body:JSON.stringify({status})});await saveAndRefresh();render();}catch(e){alert('Service update failed: '+e.message)}
  };
  window.confirmPayment=async function(id){
    let x=db.customers.find(z=>z.id===id), amount=Number(document.getElementById('paidAmount').value), expiry=document.getElementById('newExpiry').value;
    if(!amount||amount<=0){alert('Enter payment amount');return}
    if(!isBackend()){let oldDue=Number(x.due||0)+Number(x.previousDue||0);x.due=Math.max(0,oldDue-amount);x.previousDue=0;x.expiry=expiry||x.expiry;x.payment=x.due===0?'Paid':'Unpaid';db.payments.unshift({id:Date.now(),customerId:x.id,name:x.name,phone:x.phone,address:x.address,amount,date:document.getElementById('payDate').value,expiry,method:document.getElementById('method').value,note:document.getElementById('note').value});save();closeModal();go(x.payment==='Paid'?'paid':'unpaid');return}
    try{await api('/customers/'+id+'/payment',{method:'POST',body:JSON.stringify({amount,payment_date:document.getElementById('payDate').value,new_expiry_date:expiry,method:document.getElementById('method').value,note:document.getElementById('note').value})});closeModal();await saveAndRefresh();go('payments');alert('Payment saved permanently to server.');}catch(e){alert('Payment failed: '+e.message)}
  };
  window.saveFinance=async function(type){
    let source=document.getElementById('fsource').value.trim(),amount=Number(document.getElementById('famount').value),date=document.getElementById('fdate').value,note=document.getElementById('fnote').value;
    if(!source||!amount||amount<=0){alert('Please enter source/category and amount');return}
    if(!isBackend()){if(type==='income')db.incomes.unshift({id:Date.now(),source,amount,date,note});else db.expenses.unshift({id:Date.now(),category:source,amount,date,note});save();closeModal();go(type);return}
    try{let path=type==='income'?'/income':'/expenses';let body=type==='income'?{source,amount,income_date:date,note}:{category:source,amount,expense_date:date,note};await api(path,{method:'POST',body:JSON.stringify(body)});closeModal();await saveAndRefresh();go(type);alert((type==='income'?'Income':'Expense')+' saved permanently to server.');}catch(e){alert('Save failed: '+e.message)}
  };
  window.syncFromBackend=async function(){
    try{
      const [cs,ps,inc,exp]=await Promise.all([api('/customers'),api('/payments'),api('/income'),api('/expenses')]);
      // One-time migration: only when the server is completely empty.
      const localHasData=(db.customers.length>0 || db.payments.length>0 || db.incomes.length>0 || db.expenses.length>0);
      if(cs.length===0 && localHasData && !localStorage.getItem('star_server_migrated_v18')){
        let real=await migrateLocalToServer();
        if(real){localStorage.setItem('star_server_migrated_v18','1');return window.syncFromBackend();}
      }
      db.customers=cs.map(x=>({id:x.id,name:x.name,phone:x.phone,address:x.address||'',pkg:x.package_name||'Package',price:Number(x.monthly_bill||0),payment:x.payment_status,service:x.service_status,expiry:x.expiry_date||'Not set',due:Number(x.due||0),previousDue:Number(x.previous_due||0),createdAt:(x.created_at||'').slice(0,10)}));
      db.payments=ps.map(x=>({id:x.id,customerId:x.customer_id,name:x.name,phone:x.phone,address:x.address||'',amount:Number(x.amount||0),date:x.payment_date,method:x.method,expiry:x.new_expiry_date||'',note:x.note||''}));
      db.incomes=inc.map(x=>({id:x.id,source:x.source,amount:Number(x.amount||0),date:x.income_date,note:x.note||''}));
      db.expenses=exp.map(x=>({id:x.id,category:x.category,amount:Number(x.amount||0),date:x.expense_date,note:x.note||''}));
      save();render();document.getElementById('apiStatus').textContent='BACKEND: ONLINE • DATA PERMANENT';
    }catch(e){document.getElementById('apiStatus').textContent='BACKEND: OFFLINE'}
  };
  async function migrateLocalToServer(){
    try{
      // Upload customers first; keep an id map for local payment records.
      const map={};
      for(const c of db.customers){
        const r=await api('/customers',{method:'POST',body:JSON.stringify({name:c.name,phone:c.phone,address:c.address||'',monthly_bill:Number(c.price||0),payment_status:c.payment||'Unpaid',service_status:c.service||'Active',expiry_date:/^\\d{4}-\\d{2}-\\d{2}$/.test(c.expiry||'')?c.expiry:null,due:Number(c.due||0),previous_due:Number(c.previousDue||0)})});map[c.id]=r.id;
      }
      for(const p of db.payments){if(!map[p.customerId])continue;await api('/customers/'+map[p.customerId]+'/payment',{method:'POST',body:JSON.stringify({amount:Number(p.amount||0),payment_date:p.date,new_expiry_date:p.expiry||null,method:p.method||'Cash',note:p.note||''})})}
      for(const i of db.incomes){await api('/income',{method:'POST',body:JSON.stringify({source:i.source,amount:Number(i.amount||0),income_date:i.date,note:i.note||''})})}
      for(const e of db.expenses){await api('/expenses',{method:'POST',body:JSON.stringify({category:e.category,amount:Number(e.amount||0),expense_date:e.date,note:e.note||''})})}
      alert('Your old browser data has been moved to the permanent server database.');return true;
    }catch(e){alert('Old data migration failed: '+e.message);return false}
  }
})();
