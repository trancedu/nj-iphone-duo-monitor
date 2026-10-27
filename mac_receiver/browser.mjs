import {mkdirSync, realpathSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Stop, productURL, productPattern,expectedProduct,escaped} from './protocol.mjs';
import {preparePickupDetails,validatePickupDetails} from './pickup_details.mjs';
import {clearBag} from './clear_bag.mjs';
import {retainTargetVariant} from './variant_bag.mjs';
import {isPreparedProductURL,preparedPageURL,preparedProductPage,warmProductPages} from './warm_products.mjs';
const run = promisify(execFile);
const appleNavigation = value => {
  try { const u=new URL(value);return u.protocol==='https:' && (u.hostname==='www.apple.com'||/^secure\d*\.store\.apple\.com$/.test(u.hostname)); }
  catch { return false; }
};
const manualLoginNavigation = value => {
  try { const u=new URL(value);return u.protocol==='https:'&&['account.apple.com','appleid.apple.com','idmsa.apple.com'].includes(u.hostname); }
  catch { return false; }
};

export class PickupBrowser {
  constructor(config) { this.config=config;this.context=null;this.page=null;this.connected=false; }
  ready() { return this.connected && !!this.page && !this.page.isClosed(); }
  async ensurePage() {
    if(!this.connected||this.cdpBrowser&&!this.cdpBrowser.isConnected()) throw new Stop('browser_not_ready');
    if(!this.page||this.page.isClosed()) {
      this.pageCreation??=(async()=>{
        this.page=await this.context.newPage();
        this.page.setDefaultTimeout(this.config.step_timeout_ms||20000);
        this.page.setDefaultNavigationTimeout(this.config.step_timeout_ms||20000);
        this.watchPage();
      })();
      try {await this.pageCreation;} finally {this.pageCreation=null;}
    }
  }
  watchPage() {
    const page=this.page;
    if(page.__pickupCloseObserved) return;
    page.__pickupCloseObserved=true;
    page.once('close',()=>{
      // Browser shutdown also emits page close. Debounce the notification so a
      // CDP disconnect cannot be mistaken for the user's explicit tab release.
      const timer=setTimeout(()=>{
        if(this.connected&&(!this.cdpBrowser||this.cdpBrowser.isConnected())) this.onTaskTabClosed?.(page);
      },250);
      timer.unref?.();
    });
  }
  async start() {
    const {chromium}=await import('playwright');
    if(this.config.cdp_endpoint) {
      const u=new URL(this.config.cdp_endpoint);
      if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash) throw new Stop('cdp_loopback_required');
      this.cdpBrowser=await chromium.connectOverCDP(u.href,{timeout:5000});
      const contexts=this.cdpBrowser.contexts();
      if(contexts.length!==1) throw new Stop('cdp_context_ambiguous');
      this.context=contexts[0];
      const pages=this.context.pages().filter(p=>appleNavigation(p.url()));
      const workPages=[];
      for(const p of pages)if(!this.config.warm_product_pages||!await preparedPageURL(p))workPages.push(p);
      if(workPages.length>1) throw new Stop('apple_tab_ambiguous');
      this.page=workPages[0]||await this.context.newPage();
      this.connected=true;
      this.cdpBrowser.on('disconnected',()=>{this.connected=false;});
      this.page.setDefaultTimeout(this.config.step_timeout_ms||20000);
      this.page.setDefaultNavigationTimeout(this.config.step_timeout_ms||20000);
      this.watchPage();
      return;
    }
    const profile=resolve(this.config.profile_dir);
    const regular=resolve(homedir(),'Library/Application Support/Google/Chrome');
    mkdirSync(profile,{recursive:true,mode:0o700});
    const actual=realpathSync(profile);
    if (actual===regular||actual.startsWith(regular+sep)||actual===homedir()) throw new Stop('daily_profile_forbidden');
    this.context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:false});
    this.connected=true;
    this.context.on('close',()=>{this.connected=false;});
    // Only Apple top-level/checkout navigation is allowed. Never collect page bodies.
    await this.context.route('**/*',route=>{
      const req=route.request();
      if(req.isNavigationRequest()&&!req.frame().parentFrame()&&!appleNavigation(req.url())&&!manualLoginNavigation(req.url())) return route.abort();
      return route.continue();
    });
    this.page=this.context.pages()[0]||await this.context.newPage();
    this.page.setDefaultTimeout(this.config.step_timeout_ms||20000);
    this.page.setDefaultNavigationTimeout(this.config.step_timeout_ms||20000);
    this.watchPage();
    if(!this.config.preserve_page) await this.page.goto('https://www.apple.com/shop/bag',{waitUntil:'domcontentloaded'});
  }
  async guard(page=this.page) {
    if(!this.connected||!page||page.isClosed()) throw new Stop('browser_not_ready');
    if(manualLoginNavigation(page.url())) throw new Stop('login_required');
    if(!appleNavigation(page.url())) throw new Stop('unexpected_navigation');
    if(await page.getByRole('heading',{name:/^(Sign in|Sign in with your Apple Account|Verify your identity)/i}).count()) throw new Stop('login_required');
    if(await page.locator('iframe[src*="captcha"], iframe[title*="CAPTCHA"]').count()) throw new Stop('captcha_required');
    if(await page.getByRole('heading',{name:/page.*(?:can.t be|not).*found|something went wrong/i}).count()) throw new Stop('page_error');
  }
  async warmIdle() {
    await this.goto('https://www.apple.com/shop/bag');
    await clearBag(this,{confirm:true,navigate:false});
    const result=await warmProductPages(this);
    await this.goto('https://www.apple.com/shop/bag');
    await this.page.getByRole('heading',{name:/^Your bag is empty\.?$/i}).waitFor({state:'visible'});
    if(await this.page.locator(this.config.selectors.bag_item).count())throw new Stop('warmup_bag_not_empty');
    return result;
  }
  async goto(url) {
    const response=await this.page.goto(url,{waitUntil:'domcontentloaded'});
    if(response&&response.status()>=400) throw new Stop('page_error');
    await this.guard();
  }
  async bag(event) {
    await this.guard();
    const page=this.page,pattern=productPattern(event.product_url);
    const empty=page.getByRole('heading',{name:/^Your bag is empty\.?$/i});
    const rows=page.locator(this.config.selectors.bag_item);
    await Promise.race([empty.waitFor({state:'visible'}),rows.first().waitFor({state:'visible'})]);
    if(await empty.isVisible()) {
      if(await rows.count()) throw new Stop('ambiguous_bag');
      return 'empty';
    }
    await this.guard();
    // This selector MUST be verified to cover every line item on the receiving Mac.
    // Unknown layouts stop rather than weakening the quantity/other-item checks.
    if(await rows.count()!==1) throw new Stop('bag_has_other_items');
    if(await page.getByRole('combobox',{name:/Quantity for/i}).count()!==1) throw new Stop('bag_has_other_items');
    const row=rows.first();
    const quantities=row.getByRole('combobox',{name:/Quantity for/i});
    await quantities.first().waitFor({state:'visible'});
    if(await quantities.count()!==1 || await quantities.first().inputValue()!=='1') throw new Stop('bag_quantity_not_one');
    if(await row.getByRole('link',{name:pattern}).count()!==1) throw new Stop('bag_configuration_mismatch');
    return 'same_one';
  }
  async prepare(event,stage) {
    const originalZip=this.config.pickup_zip;
    this.config.pickup_zip=process.env.APPLE_PICKUP_ZIP??event.pickup_zip??originalZip;
    try{return await preparePickup(this,event,stage);}
    finally{this.config.pickup_zip=originalZip;}
  }
  async seedIdle(url=this.config.preseeded_product_url) {
    if(!url)throw new Stop('preseeded_product_required');
    await prepareBag(this,{product_url:url},()=>{});
    return {status:'single_product_seeded',product:expectedProduct(url),quantity:1};
  }
  async handoff(status='awaiting_user') {
    if(process.platform==='darwin') {
      await run('/usr/bin/osascript',['-e','tell application "Google Chrome" to activate']);
    }
    if(this.ready()) {
      if(this.config.profile_label&&this.activeProductURL)await this.page.evaluate(({label,product})=>{document.title=`[Profile ${label}] ${product} — manual handoff`;},{label:this.config.profile_label,product:expectedProduct(this.activeProductURL)});
      await this.page.bringToFront();
    }
    if(process.platform==='darwin') {
      await run('/usr/bin/afplay',['/System/Library/Sounds/Glass.aiff']);
      const label=this.config.profile_label?`Profile ${this.config.profile_label}`:'dedicated Chrome';
      const product=this.activeProductURL?expectedProduct(this.activeProductURL):'';
      const message=status==='pickup_unavailable'?`${label}: ${product}. Pickup is currently unavailable.`:`${label}: ${product}. Ready for manual review. Automation has stopped.`;
      await run('/usr/bin/osascript',['-e',`display notification ${JSON.stringify(message)} with title ${JSON.stringify('Apple pickup — '+label)}`]);
    }
  }
}

export async function prepareBag(browser,event,stage) {
  const page=browser.page;
  productURL(event.product_url);
  if(browser.config.pickup_details) validatePickupDetails(browser.config.pickup_details);
  if(!browser.ready()) throw new Stop('browser_not_ready');
  // Preflight before any add: never clear a bag or add to an unknown bag.
  await browser.goto('https://www.apple.com/shop/bag');
  stage('bag_page_ready_at');
  let existing;
  if(browser.config.bag_strategy==='preloaded_duo') existing=await retainTargetVariant(browser,event.product_url,stage);
  else try {existing=await browser.bag(event);}
  catch(error) {
    if(!browser.config.auto_clear_bag||!(error instanceof Stop)||!['bag_has_other_items','bag_quantity_not_one','bag_configuration_mismatch'].includes(error.code)) throw error;
    await clearBag(browser,{confirm:true,navigate:false});
    stage('old_bag_cleared_at');existing='empty';
  }
  stage('bag_checked_at');
  if(existing==='empty') {
    const useWarm=browser.config.warm_product_pages&&isPreparedProductURL(event.product_url);
    const productPage=useWarm?await preparedProductPage(browser,event.product_url):page;
    if(useWarm)stage('prepared_product_ready_at');
    else await browser.goto(event.product_url);
    if(new URL(productPage.url()).pathname!==new URL(event.product_url).pathname) throw new Stop('configuration_redirect');
    await productPage.getByText(productPattern(event.product_url)).first().waitFor({state:'visible'});
    stage('opened_at');
    for(const name of ['No trade-in','Connect to any carrier later']) {
      const choice=productPage.getByRole('radio',{name:new RegExp('^'+name)});
      if(await choice.count()===1) await choice.check();
    }
    await productPage.getByRole('radio',{name:'No AppleCare coverage',exact:true}).check();
    stage('care_selected_at');
    const add=productPage.getByRole('button',{name:'Add to Bag',exact:true});
    await add.waitFor({state:'visible'});
    let uncertain=false;
    stage('add_started_at');
    // Exactly one click invocation. A timeout is not permission to click again.
    try { await add.click(); } catch { uncertain=true; }
    stage('add_returned_at');
    if(!uncertain) {
      try {
        await browser.guard(productPage);
        stage('review_bag_started_at');
        if(useWarm)await browser.goto('https://www.apple.com/shop/bag');
        else await page.getByRole('button',{name:'Review Bag',exact:true}).click();
      } catch { uncertain=true; }
    }
    if(uncertain) await browser.goto('https://www.apple.com/shop/bag');
    if(await browser.bag(event)!=='same_one') throw new Stop('add_result_uncertain');
  }
  stage('bag_ready_at');
}

export async function preparePickup(browser,event,stage) {
  await prepareBag(browser,event,stage);
  const page=browser.page;
  await browser.guard();
  let applePay=page.getByRole('button',{name:/^Check\s*out with\s*(?:Apple\s*|\uF8FF\s*)?Pay$/i});
  // The real bag has a navigation and a summary copy. Use the observed unique
  // navigation ID, still constrained by the accessible Apple Pay name.
  if(await applePay.count()>1) applePay=applePay.and(page.locator('[id="shoppingCart.actions.navApwCheckout"]'));
  // Do not pick an arbitrary matching checkout button or a generic Checkout.
  if(await applePay.count()!==1) throw new Stop('apple_pay_button_missing_or_ambiguous');
  await applePay.click();
  stage('apple_pay_at');
  await openPickupList(browser);
  return inspectPickupWithRetries(browser,stage);
}

async function openPickupList(browser) {
  const page=browser.page;
  await browser.guard();
  const pickup=page.getByRole('radio',{name:/^I[’']ll pick it up/i});
  await pickup.check();
  if(!await pickup.isChecked()) throw new Stop('pickup_not_selected');
  await page.getByRole('img',{name:'Processing',exact:true}).waitFor({state:'hidden'});
  const list=page.locator(browser.config.selectors.store_list);
  const zip=page.getByRole('combobox',{name:'Zip Code or City, State',exact:true});
  await Promise.any([list.waitFor({state:'visible'}),zip.waitFor({state:'visible'})]);
  if(await zip.isVisible()) {
    if(!/^\d{5}$/.test(browser.config.pickup_zip||'')) throw new Stop('pickup_zip_required');
    await zip.fill(browser.config.pickup_zip);
    await page.getByRole('button',{name:'Apply',exact:true}).click();
    await page.getByRole('img',{name:'Processing',exact:true}).waitFor({state:'hidden'});
  }
}

export async function inspectPickupWithRetries(browser,stage) {
  const retries=browser.config.pickup_unavailable_retries??0;
  const delay=browser.config.pickup_retry_interval_ms??1000;
  if(!Number.isInteger(retries)||retries<0||retries>10||!Number.isInteger(delay)||delay<1000||delay>10000) throw new Stop('invalid_pickup_retry_config');
  for(let attempt=0;;attempt++) {
    stage(`pickup_check_${attempt}_started_at`);
    try {return await inspectPickupStores(browser,stage);}
    catch(error) {
      // Only a recognized sold-out state is retried. Unknown pages, errors,
      // captcha and failures after selecting a time/contact retain the lock.
      if(!(error instanceof Stop)||!['pickup_unavailable','configured_store_unavailable'].includes(error.code))throw error;
      stage(`pickup_check_${attempt}_unavailable_at`);
      if(attempt===retries)throw new Stop('pickup_unavailable');
    }
    await new Promise(resolve=>setTimeout(resolve,delay));
    await browser.guard();
    stage(`pickup_refresh_${attempt+1}_at`);
    await browser.page.reload({waitUntil:'domcontentloaded'});
    await openPickupList(browser);
  }
}

export async function inspectPickupStores(browser,stage) {
  const page=browser.page;
  const list=page.locator(browser.config.selectors.store_list);
  await list.waitFor({state:'visible'});
  await page.getByRole('img',{name:'Processing',exact:true}).waitFor({state:'hidden'});
  await browser.guard();
  if(browser.config.pickup_details&&browser.requestedStore) {
    const wanted=/^Apple\s/.test(browser.requestedStore)?browser.requestedStore:'Apple '+browser.requestedStore;
    const choice=list.getByRole('radio',{name:new RegExp('^'+escaped(wanted)+'(?:\\s|$)')});
    if(await choice.count()===0) {
      const more=list.getByRole('button',{name:'Show more stores',exact:true});
      if(await more.count()===1&&await more.isVisible()) {await more.click();await choice.waitFor({state:'visible'});}
    }
  }
  const rows=list.locator(browser.config.selectors.store_row);
  // Zero/unrecognized rows are unknown, not a sold-out verdict.
  if(await rows.count()===0) throw new Stop('store_list_unrecognized');
  let selectable=0,recognized=0;
  for(const row of await rows.all()) {
    const choices=row.getByRole('radio');
    for(const choice of await choices.all()) { recognized++;if(await choice.isEnabled()) selectable++; }
  }
  if(recognized===0) throw new Stop('store_list_unrecognized');
  if(selectable===0) throw new Stop('pickup_unavailable');
  if(browser.config.pickup_details) return preparePickupDetails(browser,stage);
  stage('handoff_at');
  // Hard boundary: never select a store/time, Continue, Pay, or submit an order.
  return 'awaiting_user';
}
