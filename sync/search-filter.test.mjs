import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCourseItems } from './search-filter.js';

const megaCourse = suffix =>
  'https://www.megastudy.net/teacher_v2/chr/lecture_detailview.asp?chr_cd=' + suffix;

test('course search rejects review, textbook, event, and book results', () => {
  const items = selectCourseItems([
    {
      title: '중등수학 개념완성 정규 강좌',
      link: megaCourse('100'),
      description: '강의목차와 수강 대상 안내'
    },
    {
      title: '중등수학 개념완성 수강 후기',
      link: megaCourse('101'),
      description: '직접 들어본 리뷰'
    },
    {
      title: '중등수학 개념완성',
      link: 'https://example.com/lecture_detailview?lecture_id=book',
      description: '문제집 추천과 교재 후기, 중고 교재 판매'
    },
    {
      title: '중등수학 개념완성',
      link: 'https://www.megastudy.net/book/detail.asp?pid=300',
      description: '교재 구매'
    },
    {
      title: '중등수학 개념완성 이벤트',
      link: megaCourse('102'),
      description: '프로모션'
    }
  ], '중등수학 개념완성', '메가스터디');

  assert.deepEqual(items.map(item => item.url), [megaCourse('100')]);
});

test('description noise lowers generic results without hiding an exact platform course', () => {
  const generic = selectCourseItems([{
    title: '중등수학 개념완성',
    link: 'https://example.com/lecture_detailview?lecture_id=200',
    description: '교재 추천과 문제집 후기'
  }], '중등수학 개념완성', '기타');
  assert.deepEqual(generic, []);

  const platform = selectCourseItems([{
    title: '중등수학 개념완성 정규 강좌',
    link: megaCourse('201'),
    description: '강좌에서 사용하는 교재 후기 일부와 강의목차'
  }], '중등수학 개념완성', '메가스터디');
  assert.equal(platform.length, 1);
  assert.equal(platform[0].url, megaCourse('201'));
});
