import {DUO_VARIANTS} from './variant_bag.mjs';
import {productPattern,Stop} from './protocol.mjs';

export function isPreparedProductURL(url) {
  return DUO_VARIANTS.includes(url);
}
export async function preparedPageURL(page) {
  if(isPreparedProductURL(page.url()))return page.url();
  try {
    const name=await page.evaluate(()=>window.name);
    const url=name.startsWith('pickup-prepared:')?name.slice('pickup-prepared:'.length):'';
    return DUO_VARIANTS.includes(url)?url:null;
  } catch {return null;}
}

export async function preparedProductPage(browser,url) {
  if(!DUO_VARIANTS.includes(url)) throw new Stop('unsupported_prepared_product');
  const matches=[];
  for(const p of browser.context.pages())if(!p.isClosed()&&await preparedPageURL(p)===url)matches.push(p);
  if(matches.length>1) throw new Stop('prepared_product_ambiguous');
  const page=matches[0]||await browser.context.newPage();
  page.setDefaultTimeout(browser.config.step_timeout_ms||20000);
  page.setDefaultNavigationTimeout(browser.config.step_timeout_ms||20000);
  const care=page.getByRole('radio',{name:'No AppleCare coverage',exact:true});
  const add=page.getByRole('button',{name:'Add to Bag',exact:true});
  if(page.url()!==url||!await care.isVisible()||!await add.isVisible()) {
    const response=await page.goto(url,{waitUntil:'domcontentloaded'});
    if(response&&response.status()>=400)throw new Stop('page_error');
  }
  await browser.guard(page);
  if(new URL(page.url()).pathname!==new URL(url).pathname)throw new Stop('configuration_redirect');
  await page.getByText(productPattern(url)).first().waitFor({state:'visible'});
  for(const name of ['No trade-in','Connect to any carrier later']) {
    const choice=page.getByRole('radio',{name:new RegExp('^'+name)});
    if(await choice.count()===1&&!await choice.isChecked())await choice.check();
  }
  if(!await care.isChecked())await care.check();
  await add.waitFor({state:'visible'});
  if(!await care.isChecked()||!await add.isEnabled())throw new Stop('prepared_product_not_ready');
  await page.evaluate(value=>{window.name=value;},'pickup-prepared:'+url);
  return page;
}

export async function warmProductPages(browser) {
  for(const url of DUO_VARIANTS)await preparedProductPage(browser,url);
  return {status:'four_product_pages_ready',products:4,add_clicks:0};
}
