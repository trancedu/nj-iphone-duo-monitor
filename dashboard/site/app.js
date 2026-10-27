'use strict';
let data, windowMinutes='30', historyPage=0, queryPage=0, fetching=false;
const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'America/New_York',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const fmt=t=>t?dateTime.format(new Date(t*1000)):'—', sec=n=>n==null?'—':Number(n).toFixed(2), age=t=>t?Math.max(0,Date.now()/1000-t):Infinity;
const short=sku=>(data.products[sku]?.name||sku).replace('iPhone Duo ','').replace('Star White','白色').replace('Night Sky','黑色');
const monitored=sku=>data.stores.some(s=>s.sku===sku), storeName=s=>s.replace(/^Apple /,'');
function status(){
 const fresh=age(data.monitor.last_success_at)<20 && age(data.generated_at)<20;
 $('health').textContent=fresh?'● 监控正在运行':'● 数据延迟 / 需检查';$('health').className=fresh?'good':'bad';$('live-dot').className='dot'+(fresh?' live':'');
 $('updated').textContent=`最近成功 ${fmt(data.monitor.last_success_at)}`;
 $('scope').textContent=`${data.monitor.backend||'—'} · ZIP ${data.monitor.zip||'—'} · 目标每 ${data.monitor.target_start_spacing??'—'} 秒发出 · ${data.monitor.workers??'—'} 并发`;
 const warning=age(data.generated_at)>=20?'网页数据已超过 20 秒未更新，请检查独立观察器。':age(data.collector.last_snapshot)>=20?'库存快照已超过 20 秒未更新；下方状态保留最近观察，不视为当前库存。':'';
 $('warning').hidden=!warning;$('warning').textContent=warning;
 $('last-observation').textContent=`页面数据：${fmt(data.generated_at)} · 库存快照：${fmt(data.collector.last_snapshot)}`;
}
function metrics(){
 const m=data.metrics[windowMinutes], fresh=age(data.collector.last_snapshot)<20, count=fresh?data.stores.filter(s=>s.eligible).length:null;
 const cards=[['查询成功率',m.success_percent==null?'—':m.success_percent+'','%',`${m.success} / ${m.queries} 次请求成功`],['平均成功间隔',sec(m.mean_gap),'秒',`P95 ${sec(m.p95_gap)} 秒`],['最大成功间隔',sec(m.max_gap),'秒','相邻成功返回之间的最大空档'],['错误总数',m.errors,'次',`HTTP 541：${m.counts.http_541||0} · 网络：${m.counts.network_error||0}`],['当前近期自提',count??'—','项',`门店 × 配置 · 平均成功耗时 ${sec(m.mean_latency)} 秒`]];
 $('metrics').innerHTML=cards.map(([label,v,unit,detail])=>`<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${v}<small>${unit}</small></div><div class="metric-detail">${detail}</div></div>`).join('');
}
function chart(){
 const byMinute=new Map(data.chart.map(v=>[v.at,v])), now=Math.floor(data.generated_at/60)*60, max=Math.max(1,...data.chart.map(b=>b.success+b.errors));
 $('chart').innerHTML=Array.from({length:60},(_,i)=>{const b=byMinute.get(now-(59-i)*60)||{at:now-(59-i)*60,success:0,errors:0};return `<div class="bar" title="${esc(fmt(b.at))} · 成功 ${b.success} / 错误 ${b.errors}"><div class="coral" style="height:${b.errors/max*100}%"></div><div class="green" style="height:${b.success/max*100}%"></div></div>`;}).join('');
}
function stores(){
 const groups=new Map();data.stores.forEach(s=>{if(!groups.has(s.store_id))groups.set(s.store_id,[]);groups.get(s.store_id).push(s);});
 const q=$('search').value.toLowerCase();$('store-count').textContent=`${groups.size} 家 · 4 个配置`;
 $('store-grid').innerHTML=[...groups].filter(([,ss])=>`${ss[0].store} ${ss[0].city} ${ss[0].state}`.toLowerCase().includes(q)).map(([sid,ss])=>{const s=ss[0], all=ss.slice().sort((a,b)=>short(a.sku).localeCompare(short(b.sku)));return `<article class="store-card"><div class="store-top"><h3>${esc(storeName(s.store))}</h3><small>${esc(s.state)}</small></div><div class="store-meta">${esc(s.city)} · ${esc(sid)}</div><div class="stock-grid">${all.map(p=>{const stale=age(p.observed_at)>20, cls=stale?'stale':p.eligible?'yes':p.available?'other':'', label=stale?'最近状态已过期':p.eligible?`可自提 · ${p.pickup_date}`:p.available?'有货 · 不符近期条件':'未见近期自提';return `<div class="stock ${cls}" title="${esc(p.quote)}"><b>${esc(short(p.sku))}</b>${esc(label)}</div>`;}).join('')}</div><div class="store-bottom"><span>观察 ${esc(fmt(s.observed_at))}</span><button data-store="${esc(sid)}">查看到货历史 →</button></div></article>`;}).join('')||'<div class="empty">没有匹配的门店</div>';
 $('store-grid').querySelectorAll('[data-store]').forEach(b=>b.onclick=()=>{$('store-filter').value=b.dataset.store;historyPage=0;history();$('history').scrollIntoView({behavior:'smooth'});});
}
function filters(){
 const options=new Map();[...data.stores,...data.periods].forEach(s=>options.set(s.store_id,`${s.state||''} · ${storeName(s.store)}`));const selected=$('store-filter').value;
 $('store-filter').innerHTML='<option value="">所有门店（含历史）</option>'+[...options].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('');$('store-filter').value=selected;
}
function paginate(rows,page,prefix,render){
 const pages=Math.max(1,Math.ceil(rows.length/20));page=Math.min(page,pages-1);$(prefix+'-rows').innerHTML=rows.slice(page*20,(page+1)*20).map(render).join('')||`<tr><td colspan="5" class="empty">暂无匹配记录</td></tr>`;
 $(prefix+'-count').textContent=`共 ${rows.length} 条`;
 $(prefix+'-page').textContent=`${page+1} / ${pages}`;$(prefix+'-prev').disabled=page===0;$(prefix+'-next').disabled=page+1>=pages;return page;
}
function history(){
 const sid=$('store-filter').value,cap=$('capacity').value,color=$('color').value,hours=Number($('range').value),limit=Date.now()/1000-hours*3600;
 const rows=data.periods.filter(p=>(!sid||p.store_id===sid)&&(!cap||data.products[p.sku]?.name.includes(cap))&&(!color||data.products[p.sku]?.name.includes(color))&&(!hours||(p.end||p.last_seen)>=limit));
 historyPage=paginate(rows,historyPage,'history',p=>{const current=data.stores.find(s=>s.store_id===p.store_id&&s.sku===p.sku),live=current?.eligible&&age(current.observed_at)<20;let end;
 if(p.end)end=`${esc(fmt(p.end))}<span class="sub"><span class="badge ${p.end_evidence==='query_empty'?'inferred':''}">${p.end_evidence==='query_empty'?'历史推断 · 时间上界':'快照确认 · 不再符合条件'}</span></span>`;
 else end=`<span class="badge ${live?'yes':''}">${live?'最近仍可自提':'结束未知'}</span>`;
 return `<tr><td><b>${esc(storeName(p.store))}</b><span class="sub">${esc(short(p.sku))}${monitored(p.sku)?'':' · 仅历史'}</span></td><td>${esc(fmt(p.start))}</td><td>${esc(fmt(p.last_seen))}<span class="sub">${p.observations} 次到货观察</span></td><td>${end}</td><td>${p.pickup_dates.map(esc).join('<br>')||'—'}</td></tr>`;});
}
function queries(){
 const f=$('result-filter').value, rows=data.queries.filter(q=>!f||(f==='errors'?q.result!=='http_200':q.result===f));
 queryPage=paginate(rows,queryPage,'query',q=>`<tr><td>${esc(fmt(q.finished))}</td><td><span class="badge ${q.result==='http_200'?'yes':'error'}">${esc(q.result==='http_200'?'200 · 成功':q.result)}</span></td><td>${sec(q.duration)} 秒</td><td>${q.result==='http_200'?(q.offers??'—'):'—'}</td><td>${esc(q.source)}</td></tr>`);
}
async function refresh(){
 if(fetching)return;fetching=true;
 try{const response=await fetch('data.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error('HTTP '+response.status);data=await response.json();status();metrics();chart();filters();stores();history();queries();}
 catch(e){$('warning').hidden=false;$('warning').textContent='网页数据读取失败，保留上次结果。正在自动重试。';$('health').textContent='● 网页连接异常';$('health').className='bad';$('live-dot').className='dot';}
 finally{fetching=false;}
}
$('refresh').onclick=refresh;
$('windows').querySelectorAll('button').forEach(b=>b.onclick=()=>{windowMinutes=b.dataset.window;$('windows').querySelectorAll('button').forEach(c=>c.classList.toggle('active',c===b));if(data)metrics();});
$('search').oninput=()=>data&&stores();
['store-filter','capacity','color','range'].forEach(id=>$(id).onchange=()=>{historyPage=0;if(data)history();});
$('clear-filters').onclick=()=>{['store-filter','capacity','color'].forEach(id=>$(id).value='');$('range').value='0';historyPage=0;if(data)history();};
$('result-filter').onchange=()=>{queryPage=0;if(data)queries();};
$('history-prev').onclick=()=>{historyPage--;history();};$('history-next').onclick=()=>{historyPage++;history();};
$('query-prev').onclick=()=>{queryPage--;queries();};$('query-next').onclick=()=>{queryPage++;queries();};
refresh();setInterval(()=>{if(!document.hidden)refresh();},5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
