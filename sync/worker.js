import curriculumWorker from './curriculum-fix.js';

export function cleanupCurriculum(text) {
  const kept = String(text || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^\d+강\s+선배\s*추천(?:\s|$)/.test(line));

  return kept.map((line, index) => {
    const body = line.replace(/^\d+강\s+/, '');
    return (index + 1) + '강 ' + body;
  }).join('\n');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await curriculumWorker.fetch(request, env, ctx);
    if (url.pathname !== '/curriculum' || request.method !== 'POST') return response;

    try {
      const data = await response.clone().json();
      if (!data || data.ok !== true || typeof data.text !== 'string' || !data.text) return response;
      data.text = cleanupCurriculum(data.text);
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    } catch (error) {
      return response;
    }
  }
};
