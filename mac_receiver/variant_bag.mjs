import {Stop,productPattern,productURL} from './protocol.mjs';

export const DUO_VARIANTS=['256gb','512gb'].flatMap(capacity=>['star-white','night-sky'].map(color=>`https://www.apple.com/shop/buy-iphone/iphone-duo/7.6-inch-display-${capacity}-${color}-unlocked`));

export async function inspectVariantBag(browser) {
  await browser.guard();
  const page=browser.page,rows=page.locator(browser.config.selectors.bag_item);
  const empty=page.getByRole('heading',{name:/^Your bag is empty\.?$/i});
  await Promise.any([empty.waitFor({state:'visible'}),rows.first().waitFor({state:'visible'})]);
  const count=await rows.count();
  if(await empty.isVisible()) {if(count)throw new Stop('ambiguous_bag');return [];}
  if(count<1||count>4||await page.getByRole('combobox',{name:/Quantity for/i}).count()!==count) throw new Stop('variant_bag_unrecognized');
  const found=[];
  for(const row of await rows.all()) {
    const quantity=row.getByRole('combobox',{name:/Quantity for/i});
    if(await quantity.count()!==1||await quantity.inputValue()!=='1') throw new Stop('variant_quantity_not_one');
    const heading=row.getByRole('heading',{level:2});
    if(await heading.count()!==1) throw new Stop('variant_bag_unrecognized');
    const title=await heading.innerText();
    const url=DUO_VARIANTS.find(u=>productPattern(u).test(title));
    if(!url||found.includes(url)||await row.getByRole('link',{name:productPattern(url)}).count()!==1) throw new Stop('variant_bag_unrecognized');
    if(await row.getByRole('button',{name:/^Remove\s/}).count()!==1) throw new Stop('remove_button_ambiguous');
    found.push(url);
  }
  return found;
}

export async function retainTargetVariant(browser,target,stage=()=>{}) {
  productURL(target);
  if(!DUO_VARIANTS.includes(target)) throw new Stop('unsupported_preloaded_variant');
  const found=await inspectVariantBag(browser);
  if(!found.includes(target)) throw new Stop('preloaded_target_missing');
  stage('preloaded_bag_checked_at');
  let remaining=found.length,removed=0;
  const page=browser.page,rows=page.locator(browser.config.selectors.bag_item);
  for(const url of found.filter(u=>u!==target)) {
    await browser.guard();
    if(await rows.count()!==remaining) throw new Stop('bag_changed_during_trim');
    const row=rows.filter({has:page.getByRole('link',{name:productPattern(url)})});
    const remove=row.getByRole('button',{name:/^Remove\s/});
    if(await row.count()!==1||await remove.count()!==1) throw new Stop('remove_button_ambiguous');
    const id=await remove.getAttribute('id');if(!id)throw new Stop('remove_identity_missing');
    await remove.click(); // A timeout never permits retrying an uncertain removal.
    await page.locator('[id='+JSON.stringify(id)+']').waitFor({state:'detached'});
    // Apple can replace the button before its async remove response updates the
    // actual item list. Wait on product identity and resulting row count too.
    await row.waitFor({state:'detached'});
    await rows.nth(remaining-1).waitFor({state:'detached'});
    remaining--;removed++;stage(`variant_removed_${removed}_at`);
  }
  if(await browser.bag({product_url:target})!=='same_one') throw new Stop('trim_result_uncertain');
  stage('variants_retained_at');
  return 'same_one';
}
