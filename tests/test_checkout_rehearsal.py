import unittest

from checkout_rehearsal import DEMO_URL, validate_bag, validate_product_url


class CheckoutGuardTests(unittest.TestCase):
    def test_product_navigation_rejects_non_apple_or_credential_urls(self):
        self.assertEqual(validate_product_url(DEMO_URL), DEMO_URL)
        for url in ['http://www.apple.com/shop/buy-iphone/example',
                    'https://www.apple.com.attacker.test/shop/buy-iphone/example',
                    'https://name:secret@www.apple.com/shop/buy-iphone/example',
                    'https://www.apple.com/shop/bag']:
            with self.assertRaises(ValueError):
                validate_product_url(url)

    def test_extra_or_duplicate_phone_stops_checkout(self):
        name = 'iPhone 18 Pro 256GB Burgundy'
        for products, quantities in [([name, 'iPhone Duo'], ['1', '1']), ([name], ['2']),
                                      (['iPhone Duo'], ['1']), ([], [])]:
            with self.assertRaises(ValueError):
                validate_bag(products, quantities, name)

    def test_nbsp_normalization_does_not_change_product_identity(self):
        validate_bag(['iPhone\u00a018\u00a0Pro 256GB Burgundy'], ['1'], 'iPhone 18 Pro 256GB Burgundy')


if __name__ == '__main__':
    unittest.main()
