"""PC 전용 JSON-lines 음성 작업자. 원문·생성 음성은 디스크나 외부 서비스에 쓰지 않는다."""
import base64
import io
import importlib.util
import json
import os
import sys

os.environ['HF_HOME'] = os.path.join(os.environ['WB_KOKORO_HOME'], 'models')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
if importlib.util.find_spec('en_core_web_sm') is None:
    raise RuntimeError('Install the local English language model before starting Kokoro.')
from kokoro import KPipeline
import numpy as np
import soundfile as sf
import torch

torch.set_num_threads(4)
pipeline = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', device='cpu')
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    try:
        text, rate = request['text'], request['rate']
        assert isinstance(text, str) and 0 < len(text) <= 800
        assert isinstance(rate, (int, float)) and 0.5 <= rate <= 2
        chunks = [audio.numpy() for _, _, audio in pipeline(text, voice='af_heart', speed=rate)]
        audio = np.concatenate(chunks)
        assert 0 < len(audio) <= 24000 * 120 and np.isfinite(audio).all()
        wav = io.BytesIO()
        sf.write(wav, audio, 24000, format='WAV', subtype='PCM_16')
        result = {'id': request['id'], 'audio': base64.b64encode(wav.getvalue()).decode('ascii')}
    except Exception:
        result = {'id': request['id'], 'error': True}
    print(json.dumps(result), flush=True)
