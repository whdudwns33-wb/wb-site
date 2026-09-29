import test from 'node:test';
import assert from 'node:assert/strict';
import {academySnapshot,withAcademyState} from './book-academy.js';
test('academy snapshot detects student, price, title and cancellation changes but not delivery progress',()=>{
 const row={bookId:'book',title:'자체 교재',unitPrice:1000,students:[{id:'a'}],cancelledStudents:[],stage:'ordered'};
 const reg={registered_at:10,confirmed_at:10,revision:1,snapshot:academySnapshot(row)};
 for(const stage of ['ordered','teacher_received','student_handed'])assert.equal(withAcademyState({...row,stage},reg).academyCorrectionNeeded,false);
 for(const delta of [{students:[{id:'b'}]},{unitPrice:2000},{title:'다른 교재'},{stage:'cancelled'},{cancelledStudents:[{id:'b'}]}])assert.equal(withAcademyState({...row,...delta},reg).academyCorrectionNeeded,true);
 assert.equal(withAcademyState({...row,academyRegisteredAt:10,priceCorrectedAt:11},null).academyCorrectionNeeded,true);
});
