import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from build_ach import build


class BuildAchievementTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wb-ach-test-')
        self.addCleanup(self.temp.cleanup)
        self.csv_path = Path(self.temp.name) / 'input.csv'

    def row(self, **changes):
        row = dict(school_key='test-1', school_name='가상중학교', region='광주광역시',
                   school_level='중학교', academic_year='2025', grade='1', semester='1',
                   track='전체', subject='수학', avg_score='80',
                   rate_A='20', rate_B='20', rate_C='20', rate_D='20', rate_E='20')
        row.update(changes)
        return row

    def write_rows(self, rows):
        with self.csv_path.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=self.row())
            writer.writeheader()
            writer.writerows(rows)

    def test_separate_names_and_average_only_same_school_tracks(self):
        self.write_rows([
            self.row(track='가', avg_score='70', rate_A='10', rate_E='30'),
            self.row(track='나', avg_score='90', rate_A='30', rate_E='10'),
            self.row(school_key='test-2', region='전라남도', avg_score='60', rate_A='0', rate_E='40'),
            self.row(school_key='test-3', school_name='유일중학교'),
        ])
        ach, seen, kept, lvl = build(self.csv_path)
        labels = ['가상중학교 (광주광역시)', '가상중학교 (전라남도)']
        self.assertEqual((seen, kept, len(ach['s']), len(ach['r'])), (4, 4, 3, 3))
        self.assertEqual(ach['s'], labels + ['유일중학교'])
        self.assertEqual(ach['ambiguous'], {'가상중학교': labels})
        self.assertEqual(lvl, dict.fromkeys(ach['s'], 0))
        self.assertEqual(ach['r'][0][6:], [80.0, 20.0, 20.0, 20.0, 20.0, 20.0])
        self.assertEqual(ach['r'][1][6:], [60.0, 0.0, 20.0, 20.0, 20.0, 40.0])

    def test_grade_and_core_subject_filters(self):
        high = dict(school_key='test-high', school_name='가상고등학교', school_level='고등학교')
        self.write_rows([
            self.row(**high, subject='공통수학1'),
            self.row(**high, grade='2'),
            self.row(**high, subject='과학탐구실험'),
            self.row(**high, subject='수학과제탐구'),
            self.row(**high, subject='사회과제연구'),
            self.row(**high, subject='체육'),
            self.row(grade='3', subject='한국사'),
        ])
        ach, seen, kept, lvl = build(self.csv_path)
        self.assertEqual((seen, kept, len(ach['r'])), (7, 2, 2))
        self.assertNotIn('ambiguous', ach)
        self.assertEqual(lvl, {'가상고등학교': 1, '가상중학교': 0})
        self.assertEqual({(r[1], r[3], ach['j'][r[5]]) for r in ach['r']}, {(1, 1, '수학'), (0, 3, '역사')})

    def test_invalid_or_conflicting_school_identity_is_rejected(self):
        for changes, message in [
            ({'school_key': ''}, '필수'),
            ({'school_name': ''}, '필수'),
            ({'region': ''}, '필수'),
            ({'school_name': '다른중학교'}, '같은 school_key'),
            ({'region': '전라남도'}, '같은 school_key'),
            ({'school_level': '고등학교'}, '같은 school_key'),
            ({'school_key': 'test-2'}, '표시명으로 구분'),
        ]:
            with self.subTest(changes=changes):
                self.write_rows([self.row(), self.row(**changes)])
                with self.assertRaisesRegex(ValueError, message):
                    build(self.csv_path)
        self.write_rows([
            self.row(),
            self.row(school_key='test-2', region='전라남도'),
            self.row(school_key='test-3', school_name='가상중학교 (광주광역시)'),
        ])
        with self.assertRaisesRegex(ValueError, '표시명이 충돌'):
            build(self.csv_path)

    def test_cli_writes_utf8_even_when_utf8_mode_is_disabled(self):
        self.write_rows([self.row()])
        output = Path(self.temp.name) / 'output.json'
        result = subprocess.run(
            [sys.executable, '-X', 'utf8=0', str(Path(__file__).with_name('build_ach.py')), str(self.csv_path), str(output)],
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, capture_output=True, encoding='utf-8', check=True)
        self.assertIn('학교 1곳', result.stdout)
        self.assertEqual(json.loads(output.read_text(encoding='utf-8'))['s'], ['가상중학교'])


if __name__ == '__main__':
    unittest.main()
