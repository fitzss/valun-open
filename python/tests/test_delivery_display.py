"""valun_deal shows a delivery whole up to the server's limit of 32768 bytes (fix inbox #187).

valun 0.7.2 showed the first 16,000 characters and no tool returned the rest. So a payer's agent was asked to accept,
and sign a note for, work it had seen half of, while a payee could put anything after the first 16,000 characters.
Only a delivery past the server's limit, which the server should have refused, is cut, between code points, and the
answer says so (content_complete false)."""
import unittest

from valun import agent as va


class DeliveryText(unittest.TestCase):
    def test_whole_up_to_the_server_limit(self):
        for content in ('x', 'x' * 16001, 'x' * 32000, 'x' * 32768, 'é' * 16384, '\U0001F600' * 8192):
            body, complete = va.delivery_text(content)
            self.assertEqual((body, complete), (content, True), len(content.encode('utf-8')))

    def test_past_the_limit_cut_between_code_points(self):
        body, complete = va.delivery_text('x' * 32769)
        self.assertEqual((body, complete), ('x' * 32768 + va.DELIVERY_CUT, False))
        # 32760 bytes of x, ' ' (32761), U+1F600 (32765), ' ' (32766); the next U+1F600 would make 32770
        body, complete = va.delivery_text(('x' * 32760) + ' \U0001F600' * 3)
        self.assertFalse(complete)
        self.assertEqual(body, ('x' * 32760) + ' \U0001F600 ' + va.DELIVERY_CUT)
        self.assertLessEqual(len(body[:-len(va.DELIVERY_CUT)].encode('utf-8')), va.DELIVERY_MAX_BYTES)
        self.assertIn("Don't accept work you couldn't read in full", body)

    def test_a_lone_surrogate_counts_three_bytes_as_the_server_counts_it(self):
        content = 'x' * 32765 + '\ud800'                 # 32768 bytes by Buffer.byteLength: whole
        self.assertEqual(va.delivery_text(content), (content, True))
        body, complete = va.delivery_text(content + 'y')
        self.assertEqual((body, complete), (content + va.DELIVERY_CUT, False))

    def test_the_old_cut_is_gone(self):
        content = ('x' * 15990) + ' \U0001F600' * 20     # 0.7.2's fixture: cut then, whole now
        self.assertEqual(va.delivery_text(content), (content, True))
        self.assertNotIn('truncated for display', va.DELIVERY_CUT)


if __name__ == '__main__':
    unittest.main()
