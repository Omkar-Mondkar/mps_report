"""ai/test_ai_rules.py - Unit test verification for rules and resolve logic."""
import datetime
import unittest

from ai.schema import INTENTS
from ai.rules import match_rules
from ai.resolve import resolve_date, resolve_and_validate, ResolveError, AccessDeniedError
from auth.scope import Scope


class TestAiRules(unittest.TestCase):
    def test_help_rule(self):
        spec = match_rules("help")
        self.assertIsNotNone(spec)
        self.assertEqual(spec['intent'], 'help')

    def test_otr_threshold_rule(self):
        spec = match_rules("otr > 2500 in nse fo")
        self.assertIsNotNone(spec)
        self.assertEqual(spec['intent'], 'otr_breaches')
        self.assertEqual(spec['threshold'], 2500.0)
        self.assertEqual(spec['exchange'], 'NSE')
        self.assertEqual(spec['segment'], 'FO')

    def test_otr_breaches_yesterday(self):
        spec = match_rules("show me breaches above 3000 yesterday on Greek")
        self.assertIsNotNone(spec)
        self.assertEqual(spec['intent'], 'otr_breaches')
        self.assertEqual(spec['threshold'], 3000.0)
        self.assertEqual(spec['date_from'], 'yesterday')
        self.assertEqual(spec['server'], 'Greek')

    def test_consecutive_days_rule(self):
        spec = match_rules("dealers with breaches for 5 consecutive days")
        self.assertIsNotNone(spec)
        self.assertEqual(spec['intent'], 'otr_consecutive')
        self.assertEqual(spec['days'], 5)

    def test_mps_peak_rule(self):
        spec = match_rules("peak mps nse fo today")
        self.assertIsNotNone(spec)
        self.assertEqual(spec['intent'], 'mps_peak')
        self.assertEqual(spec['exchange'], 'NSE')
        self.assertEqual(spec['segment'], 'FO')
        self.assertEqual(spec['date_from'], 'today')

    def test_dealer_filter_rule(self):
        spec = match_rules("breaches for dealer D101")
        self.assertIsNotNone(spec)
        self.assertEqual(spec['dealer'], 'D101')

    def test_date_resolution(self):
        today = datetime.date(2026, 10, 25)
        self.assertEqual(resolve_date('today', today), '2026-10-25')
        self.assertEqual(resolve_date('yesterday', today), '2026-10-24')
        self.assertEqual(resolve_date('last_5_days', today), '2026-10-20')
        self.assertEqual(resolve_date('2026-10-15', today), '2026-10-15')

    def test_resolve_and_validate_scope(self):
        cfg = {
            'servers': [{'name': 'Greek', 'ip': '10.0.0.1'}],
            'exchanges': [{'code': 'NSE', 'name': 'NSE'}, {'code': 'BSE', 'name': 'BSE'}],
            'segments': [{'code': 'CM', 'name': 'Cash'}, {'code': 'FO', 'name': 'FO'}],
            'otr_threshold': 2000.0
        }
        # Scope allows only NSE CM
        scope = Scope(grants=[('10.0.0.1', 'NSE', 'CM', '*')])

        # Query NSE CM -> OK
        spec_ok = {'intent': 'otr_breaches', 'exchange': 'NSE', 'segment': 'CM', 'server': 'Greek'}
        res = resolve_and_validate(spec_ok, cfg, scope)
        self.assertEqual(res['exchange'], 'NSE')
        self.assertEqual(res['segment'], 'CM')

        # Query NSE FO -> AccessDeniedError
        spec_denied = {'intent': 'otr_breaches', 'exchange': 'NSE', 'segment': 'FO', 'server': 'Greek'}
        with self.assertRaises(AccessDeniedError):
            resolve_and_validate(spec_denied, cfg, scope)


if __name__ == '__main__':
    unittest.main()
