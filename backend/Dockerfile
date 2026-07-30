# 그림검사 AI 해석 백엔드 · 배포용 이미지
# 빌드:  docker build -t wb-picture-test-api .
# 실행:  docker run -p 8787:8787 --env-file .env wb-picture-test-api
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 의존성 먼저 복사 → 레이어 캐시 활용
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 애플리케이션 소스
COPY src ./src
COPY db ./db

# 비루트 실행 (node 이미지에 내장된 node 사용자)
USER node

ENV PORT=8787
EXPOSE 8787

# 헬스체크: /api/health 는 인증 없이 200을 반환
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
