"""ai/test_ai_service.py - End-to-end integration tests for AI query service."""
import unittest
import os
import tempfile
import json
from ai.service import handle_ask
from auth.scope import Scope


class TestAiService(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.cfg = {
            'dir': self.tmpdir.name,
            'filename': 'MPS_Greek_{ip}_{exchange}_{segment}_{date}.csv',
            'legacy_filename': None,
            'date_format': '%d%m%Y',
            'otr_dir': self.tmpdir.name,
            'otr_filename': 'DealerWise_Order_Trade_Report_{ip}_{date}_{time}.csv',
            'otr_threshold': 2000,
            'otr_max_bytes': 67108864,
            '_otr_prefixes': {'101': ('NSE', 'CM'), '102': ('NSE', 'FO')},
            '_otr_prefix_order': ['102', '101'],
            'servers': [{'name': 'Greek', 'ip': '10.0.0.1'}],
            'exchanges': [{'code': 'NSE', 'name': 'NSE'}, {'code': 'BSE', 'name': 'BSE'}],
            'segments': [{'code': 'CM', 'name': 'Cash'}, {'code': 'FO', 'name': 'FO'}],
            'ai': {'ollama_url': 'http://127.0.0.1:11435', 'model': 'qwen2.5:1.5b-instruct'}
        }

        # Create a mock OTR file: DealerWise_Order_Trade_Report_10.0.0.1_24102026_153000.csv
        # date: 2026-10-24, time: 153000
        # Headers: user,lourtoken,symbol,series,opt_type,strike,Expiry_date,sum(gorder),sum(trade),otr
        otr_file = os.path.join(self.tmpdir.name, "DealerWise_Order_Trade_Report_10.0.0.1_24102026_153000.csv")
        content = (
            "user,lourtoken,symbol,series,opt_type,strike,Expiry_date,sum(gorder),sum(trade),otr\n"
            "D101,1020001,NIFTY,XX,CE,18000,2026-10-29,5000,2,2500.0\n"
            "D102,1010001,RELIANCE,EQ,,,2026-10-29,1000,10,100.0\n"
            "D103,1020002,BANKNIFTY,XX,PE,42000,2026-10-29,9000,3,3000.0\n"
        )
        with open(otr_file, "w", encoding="utf-8") as f:
            f.write(content)

        import re
        import mps_data as data
        self.cfg['_otr_rx'] = re.compile(
            r'^DealerWise_Order_Trade_Report_(?P<ip>[0-9A-Za-z][0-9A-Za-z.:_-]*?)_(?P<date>[0-9]{6,8})_(?P<time>[0-9]{6})\.csv$'
        )

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_help_query(self):
        res = handle_ask("help", self.cfg)
        self.assertTrue(res['ok'])
        self.assertIn("Query Assistant Help", res['answer'])
        self.assertEqual(res['meta']['source'], 'rules')

    def test_otr_breaches_fast_path(self):
        # Query: "OTR breaches > 2000 in NSE FO on 2026-10-24"
        res = handle_ask("otr breaches > 2000 in nse fo on 2026-10-24", self.cfg)
        self.assertTrue(res['ok'])
        self.assertEqual(res['meta']['source'], 'rules')
        self.assertIn("Found", res['answer'])
        # Table should contain D101 and D103 (both > 2000 in NSE FO), but not D102 (NSE CM and OTR 100)
        self.assertIsNotNone(res['table'])
        self.assertEqual(len(res['table']['rows']), 2)
        dealers = [r[0] for r in res['table']['rows']]
        self.assertIn("D101", dealers)
        self.assertIn("D103", dealers)
        self.assertNotIn("D102", dealers)

        # Check UI action payload
        self.assertIsNotNone(res['ui_action'])
        self.assertEqual(res['ui_action']['view'], 'otr')
        self.assertEqual(res['ui_action']['threshold'], 2000.0)

    def test_scope_enforcement_denial(self):
        # User restricted to BSE only
        scope = Scope(grants=[('10.0.0.1', 'BSE', 'CM', '*')])
        res = handle_ask("otr breaches > 2000 in nse fo on 2026-10-24", self.cfg, scope=scope)
        self.assertFalse(res['ok'])
        self.assertIn("Access denied", res['answer'])

    def test_scope_enforcement_allowed(self):
        # User granted NSE FO
        scope = Scope(grants=[('10.0.0.1', 'NSE', 'FO', '*')])
        res = handle_ask("otr breaches > 2000 in nse fo on 2026-10-24", self.cfg, scope=scope)
        self.assertTrue(res['ok'])
        self.assertEqual(len(res['table']['rows']), 2)

    def test_mps_peak_query(self):
        # Create mock MPS file: MPS_Greek_10.0.0.1_NSE_FO_24102026.csv
        mps_file = os.path.join(self.tmpdir.name, "MPS_Greek_10.0.0.1_NSE_FO_24102026.csv")
        with open(mps_file, "w", encoding="utf-8") as f:
            f.write("150,2026-10-24 10:00:01\n3200,2026-10-24 10:15:32\n850,2026-10-24 10:30:10\n")

        res = handle_ask("peak mps nse fo on 2026-10-24", self.cfg)
        self.assertTrue(res['ok'])
        self.assertEqual(res['meta']['intent'], 'mps_peak')
        self.assertIn("3,200", res['answer'])

    def test_otr_summary_query(self):
        res = handle_ask("summary of otr in nse fo on 2026-10-24", self.cfg)
        self.assertTrue(res['ok'])
        self.assertEqual(res['meta']['intent'], 'otr_summary')
        self.assertIn("Total Orders", res['answer'])


    def test_multi_day_otr_ranking_query(self):
        # Create additional mock OTR files for earlier dates:
        # 2026-10-23
        f23 = os.path.join(self.tmpdir.name, "DealerWise_Order_Trade_Report_10.0.0.1_23102026_153000.csv")
        with open(f23, "w", encoding="utf-8") as f:
            f.write(
                "user,lourtoken,symbol,series,opt_type,strike,Expiry_date,sum(gorder),sum(trade),otr\n"
                "D101,1020001,NIFTY,XX,CE,18000,2026-10-29,6000,2,3000.0\n"
                "D102,1010001,RELIANCE,EQ,,,2026-10-29,100,10,10.0\n"
            )
        # 2026-10-22
        f22 = os.path.join(self.tmpdir.name, "DealerWise_Order_Trade_Report_10.0.0.1_22102026_153000.csv")
        with open(f22, "w", encoding="utf-8") as f:
            f.write(
                "user,lourtoken,symbol,series,opt_type,strike,Expiry_date,sum(gorder),sum(trade),otr\n"
                "D101,1020001,NIFTY,XX,CE,18000,2026-10-29,5500,2,2750.0\n"
                "D103,1020002,BANKNIFTY,XX,PE,42000,2026-10-29,8000,3,2666.67\n"
            )

        # Query: "who breached otr the most for the last 20 days"
        res = handle_ask("who breached otr the most for the last 20 days", self.cfg)
        self.assertTrue(res['ok'])
        self.assertEqual(res['meta']['intent'], 'otr_top_breachers')
        self.assertIn("dealer(s) with OTR breaches", res['answer'])

        # Verify ranked table: D101 should be #1 (3 breaches), D103 #2 (2 breaches)
        self.assertIsNotNone(res['table'])
        self.assertEqual(len(res['table']['rows']), 2)
        top_row = res['table']['rows'][0]
        self.assertEqual(top_row[0], 'D101')  # Dealer
        self.assertEqual(top_row[1], '3')     # Breach count across 3 days

        second_row = res['table']['rows'][1]
        self.assertEqual(second_row[0], 'D103')
        self.assertEqual(second_row[1], '2')

        # Verify bar chart
        self.assertIsNotNone(res['chart'])
        self.assertEqual(res['chart']['type'], 'bar')
        self.assertEqual(res['chart']['data']['labels'], ['D101', 'D103'])
        self.assertEqual(res['chart']['data']['values'], [3, 2])

    def test_multi_day_otr_ranking_scope_isolation(self):
        # Create additional mock OTR files
        f23 = os.path.join(self.tmpdir.name, "DealerWise_Order_Trade_Report_10.0.0.1_23102026_153000.csv")
        with open(f23, "w", encoding="utf-8") as f:
            f.write(
                "user,lourtoken,symbol,series,opt_type,strike,Expiry_date,sum(gorder),sum(trade),otr\n"
                "D101,1020001,NIFTY,XX,CE,18000,2026-10-29,6000,2,3000.0\n"
                "D103,1020002,BANKNIFTY,XX,PE,42000,2026-10-29,9000,3,3000.0\n"
            )

        # Scope allowing ONLY dealer D103
        scope = Scope(grants=[('10.0.0.1', 'NSE', 'FO', 'D103')])
        res = handle_ask("who breached otr the most for the last 20 days", self.cfg, scope=scope)
        self.assertTrue(res['ok'])
        # D101 MUST NOT appear in the results for this user
        dealers = [r[0] for r in res['table']['rows']]
        self.assertIn("D103", dealers)
        self.assertNotIn("D101", dealers)


if __name__ == '__main__':
    unittest.main()

