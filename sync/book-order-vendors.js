/**
 * 화면에서 고르는 출판사와 기존 발주·전화 설정에 쓰는 raw 주문처 키의 중앙 매핑.
 * raw 키는 BOOK_VENDOR_PHONES 및 과거 주문과 호환되어야 하므로 바꾸지 않는다.
 */
export const ONLINE_BOOK_VENDOR = '쿠팡';
export const MANUAL_ONLINE_DELIVERY = 'manual_online_v1';

const RAW_PUBLISHER_VENDOR_ENTRIES = [
  ['천재교육', '천재출판사'],
  ['디딤돌', '천재출판사'],
  ['YBM', '천재출판사'],
  ['길벗스쿨', '천재출판사'],
  ['와칭국어', '천재출판사'],
  ['미래앤', '동아출판사'],
  ['동아', '동아출판사'],
  ['지학사', '동아출판사'],
  ['입시플라이', '동아출판사'],
  ['능률', '동아출판사'],
  ['백발백중', '동아출판사'],
  ['개념원리', '동아출판사'],
  ['RPM', '동아출판사'],
  ['비상', '청암출판사'],
  ['세듀', '청암출판사'],
  ['수경', '청암출판사'],
  ['메가스터디', '청암출판사'],
  ['교학사', '청암출판사'],
  ['다락원', '청암출판사'],
  ['이투스', '상형출판사'],
  ['마더텅', '상형출판사']
];

const UNLISTED_MARKERS = new Set(['', '목록에 없음', '__unlisted__', 'unlisted']);

function lookupKey(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
}

const publisherRows = RAW_PUBLISHER_VENDOR_ENTRIES.map(([publisherName, vendorName]) =>
  Object.freeze({ publisherName, vendorName }));
const publisherByKey = new Map(publisherRows.map(row => [lookupKey(row.publisherName), row]));

export const BOOK_PUBLISHER_VENDOR_MAP = Object.freeze(publisherRows);

/**
 * @returns {{publisherName:string,vendorName:string,listed:boolean}|null}
 * null은 임의 출판사명으로 raw 주문처를 우회하려는 요청이다.
 */
export function resolveBookPublisher(value) {
  const normalized = String(value == null ? '' : value).normalize('NFKC').trim();
  const key = lookupKey(normalized);
  if (UNLISTED_MARKERS.has(key)) {
    return { publisherName: '', vendorName: ONLINE_BOOK_VENDOR, listed: false };
  }
  const row = publisherByKey.get(key);
  return row ? { ...row, listed: true } : null;
}

export function isRawBookVendor(value) {
  const vendor = String(value == null ? '' : value).normalize('NFKC').trim();
  return vendor === ONLINE_BOOK_VENDOR || publisherRows.some(row => row.vendorName === vendor);
}
