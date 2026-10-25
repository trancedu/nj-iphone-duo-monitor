'use strict';
(() => {
  const D=window.GUIDE_DATA;
  if(!D)return;
  const $=id=>document.getElementById(id);
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const nice=s=>String(s).replace(/&#x27;/g,"'");
  const stamp=s=>new Date(s).toLocaleString('zh-CN',{timeZone:'America/New_York',hour12:false});
  document.querySelectorAll('[data-generated]').forEach(el=>el.textContent=stamp(D.generatedAt));
  if($('source-commit'))$('source-commit').textContent=D.commit;
  document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',async()=>{
    const text=$(button.dataset.copy).textContent;
    try{
      if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(text);
      else{const area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');area.style.cssText='position:fixed;left:-9999px;top:0';document.body.appendChild(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw new Error('copy');}
      const previous=button.textContent;button.textContent='已复制';setTimeout(()=>button.textContent=previous,1500);
    }catch{button.textContent='请选中代码复制';}
  }));
  if($('flow-next')){
    let step=0,kind='empty';
    const titles=['读取配置，准备这一轮','库存请求 #1：Mac → Apple','响应 #1：Apple → Mac','在本地判断是否需要提醒','库存请求 #2：换另一个区域','这一轮完成，等待下一轮'];
    function render(){
      let desc=[
        '选择固定白色 256GB 与随机另一个版本，再选择 07078 和 08002。到这里还没有发出 HTTP 请求。',
        '发出 GET，URL 中包含 location=07078、parts.0 和 parts.1。一条请求同时查两个型号。',
        'Apple 针对这一个 GET 返回 JSON。一个响应里有多个门店，每个门店下面又有两个 SKU 的取货状态。',
        kind==='stock'?'教学场景假定查到今天可取货：程序通过去重检查后，向 Telegram 另外发一次 POST，并在成功后打开商品页。':'教学场景假定两款均不可取货：记录结果，不发送 Telegram。接收响应、解析 JSON 都不需要再给 Apple 发请求。',
        '第一批结果处理完后，再等待至少 5 秒，发出 location=08002 的 GET；型号仍是这一轮同样的两款。',
        '第二个区域返回后保存结果。平时等待到下一轮约 60–70 秒的节奏；早晨加速窗口约 20–22 秒，失败则更慢。'
      ][step];
      $('flow-title').textContent=titles[step];$('flow-description').textContent=desc;
      $('flow-track').innerHTML=Array.from({length:6},(_,i)=>`<div class="${i<=step?'done':''}"></div>`).join('');
      ['flow-mac','flow-apple','flow-tg'].forEach(id=>$(id).classList.remove('active'));
      $((step===1||step===2||step===4)?'flow-apple':(step===3&&kind==='stock'?'flow-tg':'flow-mac')).classList.add('active');
      const gets=step>=4?2:step>=1?1:0,posts=kind==='stock'&&step>=3?1:0;
      $('flow-count').textContent=`步骤 ${step+1}/6 · 库存 GET ${gets} 次 · Telegram POST ${posts} 次`;
      $('flow-next').textContent=step===5?'重新走一轮 ↻':'下一步 →';
    }
    $('flow-next').addEventListener('click',()=>{step=(step+1)%6;render();});
    $('flow-reset').addEventListener('click',()=>{step=0;render();});
    document.querySelectorAll('[data-flow-case]').forEach(b=>b.addEventListener('click',()=>{kind=b.dataset.flowCase;step=0;document.querySelectorAll('[data-flow-case]').forEach(x=>x.setAttribute('aria-pressed',x===b));render();}));render();
  }
  if($('request-region')){
    const names={'short-hills':'Short Hills / 北 NJ','manhattan':'纽约市','south-nj':'南部与中部 NJ','smith-haven':'长岛 / Westchester','syracuse':'纽约州北部'};
    $('request-region').innerHTML=D.regions.map(r=>`<option value="${esc(r.zip)}">${esc(r.zip)} · ${esc(names[r.name])}</option>`).join('');
    $('request-second').innerHTML=Object.entries(D.products).filter(([sku])=>sku!==D.defaultSku).map(([sku,p])=>`<option value="${esc(sku)}">${esc(p.name.replace('iPhone Duo ',''))} · ${esc(sku)}</option>`).join('');
    $('request-second').value=D.exampleSecond;
    function build(){const params=new URLSearchParams({pl:'true',location:$('request-region').value});params.set('parts.0',D.defaultSku);params.set('parts.1',$('request-second').value);const path='/shop/retail/pickup-message?'+params.toString();$('request-url').textContent='https://www.apple.com'+path;$('request-wire').textContent=`GET ${path} HTTP/1.1\nHost: www.apple.com\nUser-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15\nReferer: https://www.apple.com/shop/buy-iphone/iphone-duo\n\n（GET 请求没有正文；参数都在第一行的 URL 里）`;}
    $('request-region').addEventListener('change',build);$('request-second').addEventListener('change',build);build();
  }
  if($('response-json')){
    let kind='real',field='http';
    const explanations={
      http:['HTTP 200：成功收到响应','它不是库存布尔值。Apple 可以成功返回一份“所有店都无货”的 JSON，HTTP 状态仍然是 200。'],
      stores:['body.stores[]：门店数组','数组中的每个对象是一家门店；storeNumber 是店号，storeName 是名称。当前页面为了阅读只保留 Short Hills，一次真实区域响应有更多门店。'],
      sku:['partsAvailability[SKU]：把型号分开看','同一家店内，MK1E4LL/A 对应白色 256GB；另一个 key 对应另一个颜色、容量。不能把别的型号有货，解释成 256GB 有货。'],
      display:['pickupDisplay：该型号的取货显示状态','当前代码只接受 available / unavailable。还要结合 regular.storeSelectionEnabled 与明确 pickup 日期，才能发提醒。'],
      enabled:['messageTypes.regular.storeSelectionEnabled','这是型号下面的取货门店选择标志。程序要求它为 true，且 pickupDisplay 为 available。只有一个条件成立还不够。'],
      date:['明确 pickup 日期：今天至未来 3 天','先找 pickup 专用编码；没有时解析取货文案中的 Today / Tomorrow / 明确日期。没有可解析日期会报错；七天后的取货日期会被规则筛掉。'],
      trap:['storePickEligible / retailStore.availableNow 不能单独当库存','真实快照里这两个字段为 true，但这款手机的 pickupDisplay 仍为 unavailable，门店选择为 false。它们处于资格或门店元数据层，当前程序不拿它们触发有货提醒。']
    };
    function renderField(){const e=explanations[field];$('field-explanation').innerHTML=`<strong>${esc(e[0])}</strong><p>${esc(e[1])}</p>`;}
    function render(){const body=JSON.parse(JSON.stringify(D.response));const part=body.body.stores[0].partsAvailability[D.defaultSku];
      let source=`真实快照：${stamp(D.snapshotAt)}（美东），邮编 07078。正文来自实际响应，已裁剪为一个门店和关键字段，不代表现在库存。`;
      let decision='结果：这一次采样中，白色 256GB 在 Short Hills 不可取货；不发库存提醒。';let tone='';
      if(kind==='available'||kind==='far'){
        part.pickupDisplay='available';part.messageTypes.regular.storeSelectionEnabled=true;
        part.pickupSearchQuote='Available Today';part.messageTypes.regular.storePickupQuote='Today at Apple Short Hills';
        if(kind==='far'){const date=new Date(D.snapshotAt.slice(0,10)+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+7);const label=date.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});part.pickupSearchQuote='Available '+label;part.messageTypes.regular.storePickupQuote=label+' at Apple Short Hills';part.pickupEncodedUpperDateString=date.toISOString().slice(0,10).replaceAll('-','');decision='结果：有明确取货日期，但比示例采样日远 7 天，超过 3 天规则，不发近期库存提醒。';}
        else{decision='结果：通过库存与日期检查。若同店 / 同 SKU / 同日期 30 分钟内尚未提醒，则发 Telegram。';tone='ok';}
        source='教学示例：在真实结构上人为修改取货状态，展示判断逻辑。这不是当前或历史有货证据。';
      }
      if(kind==='missing'){delete body.body.stores[0].partsAvailability[D.defaultSku];source='教学示例：人为删除请求中的一个 SKU，展示返回不完整时的处理。';decision='结果：查询失败（缺少请求的 SKU）。不会把这个型号记成无货；进入错误处理与退避。';tone='error';}
      $('response-json').textContent=JSON.stringify(body,null,2);$('response-source').textContent=source;$('response-kind').textContent=kind==='real'?'真实响应节选':'教学数据';$('response-kind').className='pill'+(kind==='real'?'':' amber');$('response-decision').textContent=decision;$('response-decision').className='decision '+tone;renderField();
    }
    document.querySelectorAll('[data-response]').forEach(b=>b.addEventListener('click',()=>{kind=b.dataset.response;document.querySelectorAll('[data-response]').forEach(x=>x.setAttribute('aria-pressed',x===b));render();}));
    document.querySelectorAll('[data-json-field]').forEach(b=>b.addEventListener('click',()=>{field=b.dataset.jsonField;document.querySelectorAll('[data-json-field]').forEach(x=>x.setAttribute('aria-pressed',x===b));renderField();}));render();
  }
  if($('round-buttons')){
    let round=0;
    const primary=D.regions.filter(r=>r.tier==='primary'),secondary=D.regions.filter(r=>r.tier==='secondary');
    const others=Object.keys(D.products).filter(s=>s!==D.defaultSku);
    $('round-buttons').innerHTML=Array.from({length:6},(_,i)=>`<button class="btn" data-round="${i}" aria-pressed="${i===0}">第 ${i+1} 轮</button>`).join('');
    const areaName={'short-hills':'Short Hills / 北 NJ','manhattan':'纽约市','south-nj':'南部与中部 NJ','smith-haven':'长岛 / Westchester','syracuse':'纽约州北部'};
    $('region-table').innerHTML=D.regions.map(r=>`<tr><td><code>${esc(r.zip)}</code></td><td>${r.tier==='primary'?'核心组':'外围组'} · ${esc(areaName[r.name])}</td><td>${r.responseCount}</td><td>${r.expected_stores.length}</td></tr>`).join('');
    function render(){const nowRegions=[primary[round%primary.length],secondary[round%secondary.length]],nowSet=new Set(nowRegions.flatMap(r=>r.expected_stores));const cumulative=new Set();for(let i=0;i<=round;i++){primary[i%primary.length].expected_stores.forEach(s=>cumulative.add(s));secondary[i%secondary.length].expected_stores.forEach(s=>cumulative.add(s));}
      const interval=Number($('rotation-speed').value),second=others[(round*3)%others.length];
      $('round-detail').innerHTML=`<div class="top"><strong>本轮 ${nowSet.size} 家 · 累计 ${cumulative.size} / 35 家</strong><span class="small">理想轮次起点：+${round*interval} 秒</span></div>${nowRegions.map((r,i)=>`<div class="reqrow"><code>GET #${i+1}</code><span><b>location=${esc(r.zip)}</b> · ${esc(areaName[r.name])}<br><span class="small">同一请求包含 白色 256GB + ${esc(D.products[second].name.replace('iPhone Duo ',''))}</span></span><span class="tag">${r.expected_stores.length} 家目标店</span></div>`).join('')}<p class="tiny">时间仅示意轮次起点，未计网络、解析和随机抖动。第二个请求在第一批处理完成后再等待至少 5 秒。其他型号的演示抽样顺序不是后台当前随机结果。</p>`;
      $('store-grid').innerHTML=Object.entries(D.stores).sort((a,b)=>a[1].state.localeCompare(b[1].state)||a[1].name.localeCompare(b[1].name)).map(([sid,s])=>`<div class="store ${nowSet.has(sid)?'now':cumulative.has(sid)?'seen':''}" title="${esc(sid+' '+nice(s.name))}"><b>${esc(s.state+' · '+sid)}</b>${esc(nice(s.name))}</div>`).join('');
      document.querySelectorAll('[data-round]').forEach(b=>b.setAttribute('aria-pressed',Number(b.dataset.round)===round));
    }
    document.querySelectorAll('[data-round]').forEach(b=>b.addEventListener('click',()=>{round=Number(b.dataset.round);render();}));$('rotation-speed').addEventListener('change',render);render();
  }
  if($('failure-detail')){
    const failures={apple:['停止这一轮，延长下一次查询间隔','HTTP / 网络失败会进入查询错误路径，不会记成售罄。连续失败按基础 5、10、20、40、60 分钟退避，服务器给出更长 Retry-After 时遵从更长等待。早晨 20 秒模式不会覆盖错误退避。'],schema:['有响应，但内容不完整，仍算查询失败','location 不匹配、预期门店缺失、请求的 SKU 缺失、取货字段结构异常，都不能当正常完整查询。持续异常由独立 watchdog 汇报。'],telegram:['库存查询可能成功，通知投递失败','失败的提醒不写入 sent 去重记录，外层把本轮标为 degraded，约五分钟后重试。watchdog 的通知发送失败也会等待至少五分钟再尝试，避免连续弹。'],browser:['Telegram 已发成功；浏览器失败单独记录','open 商品页失败会写日志，但不会撤销已经发出的 Telegram，也不会停止下一轮库存查询。你仍可从 Telegram 里的商品链接进入。']};
    function render(kind){const item=failures[kind];$('failure-detail').innerHTML=`<strong>${esc(item[0])}</strong><span>${esc(item[1])}</span>`;}
    document.querySelectorAll('[data-failure]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-failure]').forEach(x=>x.setAttribute('aria-pressed',x===b));render(b.dataset.failure);}));render('apple');
  }
})();
