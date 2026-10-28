#!/usr/bin/env python3
"""Replay the observed Apple checkout preparation; payment remains manual."""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DEMO_URL = 'https://www.apple.com/shop/buy-iphone/iphone-18-pro/6.3-inch-display-256gb-burgundy-unlocked'
DEMO_NAME = 'iPhone 18 Pro 256GB Burgundy'


def validate_product_url(url):
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'www.apple.com' or parsed.username or parsed.password
            or not parsed.path.startswith('/shop/buy-iphone/')):
        raise ValueError('Use an HTTPS Apple US iPhone product URL')
    return url


def normalize(text):
    return ' '.join(text.split())


def validate_bag(product_names, quantities, expected_name):
    if [normalize(name) for name in product_names] != [normalize(expected_name)] or quantities != ['1']:
        raise ValueError('Bag must contain exactly one matching phone, quantity one. No items were removed.')


def run(args):
    # This dependency is optional and unrelated to the stock monitor's stdlib runtime.
    from playwright.sync_api import sync_playwright, expect

    output = ROOT / 'runtime' / 'checkout' / dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    output.mkdir(parents=True)
    report = {'product_url': args.url, 'product_name': args.product_name, 'steps': [],
              'payment_automated': False, 'status': 'starting'}
    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(ROOT / 'runtime' / 'checkout-chrome-profile'), channel='chrome',
            headless=False, viewport={'width': 1280, 'height': 900},
            record_video_dir=str(output / 'videos'), record_video_size={'width': 1280, 'height': 900})
        context.set_default_timeout(20000)
        context.tracing.start(screenshots=True, snapshots=True, sources=False)
        page = context.pages[0] if context.pages else context.new_page()

        def checkpoint(label):
            page.screenshot(path=str(output / (label + '.png')))
            report['steps'].append({'step': label, 'url': page.url})
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))

        try:
            page.goto('https://www.apple.com/shop/bag', wait_until='domcontentloaded')
            if not args.resume_bag:
                # Never clear a user's existing bag or add duplicate phones on rerun.
                expect(page.get_by_role('heading', name='Your bag is empty.', exact=True)).to_be_visible()
                page.goto(args.url, wait_until='domcontentloaded')
                care = page.get_by_role('radio', name='No AppleCare coverage', exact=True)
                care.check()
                expect(care).to_be_checked()
                expect(page.get_by_role('radio', name='No trade-in', exact=True)).to_be_checked()
                expect(page.get_by_role('radio', name=re.compile(r'^Buy \$'))).to_be_checked()
                expect(page.get_by_role('radio', name=re.compile(r'^Connect to any carrier later'))).to_be_checked()
                checkpoint('01-no-applecare')
                page.get_by_role('button', name='Add to Bag', exact=True).click()
                page.get_by_role('button', name='Review Bag', exact=True).click()
                page.wait_for_url('https://www.apple.com/shop/bag')

            main = page.get_by_role('main')
            expected_heading = main.get_by_role('heading', name=args.product_name, exact=True, level=2)
            expect(expected_heading).to_be_visible()
            removes = main.get_by_role('button', name=re.compile(r'^Remove '))
            if removes.count() != 1:
                raise ValueError('Extra bag items detected. Clear them manually or use a separate browser profile.')
            quantities = main.get_by_role('combobox', name=re.compile(r'^Quantity for '))
            if quantities.count() != 1:
                raise ValueError('Quantity control changed; manual review required')
            validate_bag([expected_heading.inner_text()], [quantities.input_value()], args.product_name)
            checkpoint('02-review-bag')
            # This is the bag checkout entry, not a payment authorization control.
            main.get_by_role('button', name='Check out with Pay', exact=True).first.click()
            expect(page.get_by_role('heading', name='How would you like to get your order?', exact=True)).to_be_visible()
            page.get_by_role('radio', name='I’ll pick it up', exact=True).check()
            checkpoint('03-pickup-options')

            if args.store and args.pickup_date and args.window:
                store = page.get_by_role('radio', name=re.compile(r'^' + re.escape(args.store) + r'\s'))
                if store.count() == 0:
                    page.get_by_role('button', name='Show more stores', exact=True).click()
                expect(store).to_have_count(1)
                if 'Available' not in store.inner_text() and 'Available' not in (store.get_attribute('aria-label') or ''):
                    # Some radio names are supplied via associated labels rather than inner text.
                    expect(page.get_by_role('radio', name=re.compile(r'^' + re.escape(args.store) + r'\s.*Available'))).to_be_visible()
                store.check()
                page.get_by_role('radio', name=re.compile('^' + re.escape(args.pickup_date) + '$', re.I)).check()
                page.get_by_role('combobox', name=re.compile(r'^Next, select a check-in window')).select_option(label=args.window)
                checkpoint('04-selected-pickup-window')
                page.get_by_role('button', name='Continue to Pickup Details', exact=True).click()
                # The next step was not successfully verified in the live rehearsal.
                # Capture it for the human; do not guess contact/payment controls.
                page.wait_for_load_state('domcontentloaded')
                checkpoint('05-after-continue-attempt')
                report['handoff_reason'] = 'Continue was attempted; inspect the resulting page manually (later steps unverified)'
            else:
                report['handoff_reason'] = 'Select and verify pickup store, date and check-in window manually'

            report['status'] = 'manual_handoff'
            print('Stopped for manual review. No Pay/Place Order action exists in this script.')
            print('Verify pickup store, date, time, contact details and total yourself.')
        except Exception as exc:
            report['status'] = 'stopped_on_error'
            report['error_type'] = type(exc).__name__
            # Avoid serializing page/cookie/token-bearing exception text.
            try:
                checkpoint('stopped-on-error')
            except Exception:
                pass
            print('Flow stopped: ' + type(exc).__name__)
        finally:
            # Stop trace before any manual entry of contact/payment details.
            context.tracing.stop(path=str(output / 'trace.zip'))
            (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print('Artifacts: ' + str(output))
            print('Browser remains open for inspection; press Enter here to close and finalize the video.')
            try:
                input()
            finally:
                context.close()
    return 0 if report['status'] == 'manual_handoff' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=DEMO_URL)
    parser.add_argument('--product-name', default=DEMO_NAME)
    parser.add_argument('--resume-bag', action='store_true', help='Validate existing single-item bag without adding another phone')
    parser.add_argument('--store', help='Exact displayed store name, e.g. Apple West 14th Street')
    parser.add_argument('--pickup-date', help='Exact displayed date name; never assume a date automatically')
    parser.add_argument('--window', help='Exact displayed time-window label')
    args = parser.parse_args()
    try:
        validate_product_url(args.url)
    except ValueError as exc:
        parser.error(str(exc))
    if any([args.store, args.pickup_date, args.window]) and not all([args.store, args.pickup_date, args.window]):
        parser.error('--store, --pickup-date and --window must be provided together')
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
