import {mkdirSync, realpathSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Stop, productURL, productPattern} from './protocol.mjs';
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
  async start() {
    const {chromium}=await import('playwright');
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
    if(!this.config.preserve_page) await this.page.goto('https://www.apple.com/shop/bag',{waitUntil:'domcontentloaded'});
  }
  async guard() {
    if(!this.ready()) throw new Stop('browser_not_ready');
    if(manualLoginNavigation(this.page.url())) throw new Stop('login_required');
    if(!appleNavigation(this.page.url())) throw new Stop('unexpected_navigation');
    if(await this.page.getByRole('heading',{name:/^(Sign in|Sign in with your Apple Account|Verify your identity)/i}).count()) throw new Stop('login_required');
    if(await this.page.locator('iframe[src*="captcha"], iframe[title*="CAPTCHA"]').count()) throw new Stop('captcha_required');
    if(await this.page.getByRole('heading',{name:/page.*(?:can.t be|not).*found|something went wrong/i}).count()) throw new Stop('page_error');
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
    return preparePickup(this,event,stage);
  }
  async handoff() {
    if(process.platform==='darwin') {
      await run('/usr/bin/osascript',['-e','tell application "Google Chrome" to activate']);
    }
    if(this.ready()) await this.page.bringToFront();
    if(process.platform==='darwin') {
      await run('/usr/bin/afplay',['/System/Library/Sounds/Glass.aiff']);
      await run('/usr/bin/osascript',['-e','display notification "Inspect the dedicated Chrome window. Automation has stopped." with title "Apple pickup — manual handoff"']);
    }
  }
}

export async function preparePickup(browser,event,stage) {
  const page=browser.page;
  productURL(event.product_url);
  if(!browser.ready()) throw new Stop('browser_not_ready');
  // Preflight before any add: never clear a bag or add to an unknown bag.
  await browser.goto('https://www.apple.com/shop/bag');
  const existing=await browser.bag(event);
  if(existing==='empty') {
    await browser.goto(event.product_url);
    if(new URL(page.url()).pathname!==new URL(event.product_url).pathname) throw new Stop('configuration_redirect');
    await page.getByText(productPattern(event.product_url)).first().waitFor({state:'visible'});
    stage('opened_at');
    for(const name of ['No trade-in','Connect to any carrier later']) {
      const choice=page.getByRole('radio',{name:new RegExp('^'+name)});
      if(await choice.count()===1) await choice.check();
    }
    await page.getByRole('radio',{name:'No AppleCare coverage',exact:true}).check();
    const add=page.getByRole('button',{name:'Add to Bag',exact:true});
    await add.waitFor({state:'visible'});
    let uncertain=false;
    // Exactly one click invocation. A timeout is not permission to click again.
    try { await add.click(); } catch { uncertain=true; }
    if(!uncertain) {
      try {
        await browser.guard();
        await page.getByRole('button',{name:'Review Bag',exact:true}).click();
      } catch { uncertain=true; }
    }
    if(uncertain) await browser.goto('https://www.apple.com/shop/bag');
    if(await browser.bag(event)!=='same_one') throw new Stop('add_result_uncertain');
  }
  stage('bag_ready_at');
  await browser.guard();
  const applePay=page.getByRole('button',{name:/^Check\s*out with\s*(?:Apple\s*)?Pay$/i});
  // Do not pick an arbitrary matching checkout button or a generic Checkout.
  if(await applePay.count()!==1) throw new Stop('apple_pay_button_missing_or_ambiguous');
  await applePay.click();
  stage('apple_pay_at');
  await browser.guard();
  const pickup=page.getByRole('radio',{name:/^I[’']ll pick it up/i});
  await pickup.check();
  if(!await pickup.isChecked()) throw new Stop('pickup_not_selected');
  await page.getByRole('img',{name:'Processing',exact:true}).waitFor({state:'hidden'});
  const list=page.locator(browser.config.selectors.store_list);
  await list.waitFor({state:'visible'});
  await page.getByRole('img',{name:'Processing',exact:true}).waitFor({state:'hidden'});
  await browser.guard();
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
  stage('handoff_at');
  // Hard boundary: never select a store/time, Continue, Pay, or submit an order.
  return 'awaiting_user';
}
