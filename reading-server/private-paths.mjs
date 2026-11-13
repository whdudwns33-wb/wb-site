import path from 'node:path';

// 명시한 교재 폴더와 같은 외장 자료 보관함에 음성을 둔다.
// 설정이 없으면 원래 DATA_DIR 배치를 그대로 쓴다.
export function privatePaths(dataDir, materialDir = process.env.WB_NAESIN_MATERIALS_DIR) {
  const data = path.resolve(dataDir);
  if (materialDir && !path.isAbsolute(materialDir)) throw new Error('교재 폴더는 절대 경로여야 합니다.');
  const materials = materialDir ? path.resolve(materialDir) : path.join(path.dirname(data), 'naesin-materials');
  return { materials, audio: path.join(materialDir ? path.dirname(materials) : data, 'naesin-audio') };
}
