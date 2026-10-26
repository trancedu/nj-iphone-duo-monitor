import {Stop} from './protocol.mjs';

// Deliberately separate from preparePickup and from the LAN receiver API.
export async function clearBag(browser,{confirm=false,maxItems=20,navigate=true}={}) {
  if(navigate) await browser.goto('https://www.apple.com/shop/bag');
  const page=browser.page;
  const empty=page.getByRole('heading',{name:/^Your bag is empty\.?$/i});
  const rows=page.locator(browser.config.selectors.bag_item);
  await Promise.any([empty.waitFor({state:'visible'}),rows.first().waitFor({state:'visible'})]);
  if(await empty.isVisible()) {
    if(await rows.count()) throw new Stop('ambiguous_bag');
    return {status:'bag_empty',removed:0};
  }
  const count=await rows.count();
  if(count<1||count>maxItems) throw new Stop('bag_layout_unrecognized');
  if(await page.getByRole('combobox',{name:/Quantity for/i}).count()!==count) throw new Stop('bag_layout_unrecognized');
  const buttons=rows.getByRole('button',{name:/^Remove\s/});
  if(await buttons.count()!==count) throw new Stop('remove_button_ambiguous');
  if(!confirm) return {status:'clear_preview',items:count,removed:0};
  let remaining=count;
  for(let removed=0;removed<count;removed++) {
    await browser.guard();
    if(await rows.count()!==remaining) throw new Stop('bag_changed_during_clear');
    // This is explicit removal of every row, not an arbitrary purchase action.
    const row=rows.nth(0),remove=row.getByRole('button',{name:/^Remove\s/});
    if(await remove.count()!==1) throw new Stop('remove_button_ambiguous');
    const id=await remove.getAttribute('id');
    if(!id) throw new Stop('remove_identity_missing');
    await remove.click(); // Never retry an uncertain destructive click.
    await page.locator('[id='+JSON.stringify(id)+']').waitFor({state:'detached'});
    await rows.nth(remaining-1).waitFor({state:'detached'});
    remaining--;
  }
  await empty.waitFor({state:'visible'});
  if(await rows.count()) throw new Stop('clear_result_uncertain');
  return {status:'bag_empty',removed:count};
}
