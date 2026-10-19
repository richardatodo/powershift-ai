"""Local-only model evaluation; synthetic smoke cases are not production accuracy."""
import argparse
import base64
from dataclasses import replace
from decimal import Decimal
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from backend.api.config import ScanSettings
from backend.api.errors import APIError
from backend.api.scanning import ImageLimits, validated_image
from backend.api.vision import OllamaAdapter


def generate(directory):
    directory.mkdir(parents=True, exist_ok=True)
    cases = [
        ('clear', ['APPLIANCE RATING LABEL', 'Brand: TESTCO', 'Model: FAN-60', 'Rated input power: 60 W', 'Voltage: 230 V'], 60),
        ('blurry', ['APPLIANCE RATING', 'Rated input power: 75 W'], None),
        ('missing_label', [], None),
        ('va_only', ['APPLIANCE RATING', 'Apparent power: 500 VA', 'Voltage: 230 V', 'Current: 2.2 A'], None),
        ('ambiguous', ['APPLIANCE RATING', 'Input power: 900 W', 'Output power: 600 W'], None),
        ('kw_only', ['APPLIANCE RATING', 'Rated power: 1.2 kW'], None),
    ]
    manifest=[]
    try: font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',32)
    except OSError: font=ImageFont.load_default(size=32)
    for name, lines, expected in cases:
        image=Image.new('RGB',(900,420),'white');draw=ImageDraw.Draw(image)
        for i,line in enumerate(lines): draw.text((35,30+i*60),line,fill='black',font=font)
        if name=='blurry': image=image.filter(ImageFilter.GaussianBlur(20))
        image.save(directory/(name+'.png'))
        manifest.append({'id':name,'image':name+'.png','expected_watts':expected,'kind':'synthetic'})
    (directory/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generate-synthetic',type=Path)
    parser.add_argument('--manifest',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--timeout',type=int,default=120)
    parser.add_argument('--model',default='gemma4:e2b-it-qat')
    args=parser.parse_args()
    if args.generate_synthetic:
        generate(args.generate_synthetic)
        return
    if not args.manifest or not args.output: parser.error('--manifest and --output are required')
    settings=replace(ScanSettings(provider='ollama'),model=args.model,timeout_seconds=args.timeout)
    provider=OllamaAdapter(settings)
    cases=json.loads(args.manifest.read_text());results=[]
    try:
        for case in cases:
            start=time.monotonic();path=(args.manifest.parent/case['image']).resolve()
            if path.suffix.lower() not in ('.png','.jpg','.jpeg','.webp'): raise ValueError('Unsupported fixture type')
            mime={'.jpg':'jpeg','.jpeg':'jpeg','.png':'png','.webp':'webp'}[path.suffix.lower()]
            raw=path.read_bytes();record={'id':case['id'],'kind':case.get('kind','unspecified'),'expected_watts':case['expected_watts']}
            try:
                data=validated_image(f'data:image/{mime};base64,'+base64.b64encode(raw).decode(),
                    ImageLimits(settings.max_image_bytes,settings.max_pixels,settings.max_side))
                result=provider.extract(data);watts=result['watts']
                record.update(actual_watts=str(watts) if watts is not None else None,
                    exact_match=(watts is None and case['expected_watts'] is None) or
                    (watts is not None and case['expected_watts'] is not None and watts==Decimal(str(case['expected_watts']))),error_code=None)
            except APIError as error:
                record.update(actual_watts=None,exact_match=False,error_code=error.code)
            record['seconds']=round(time.monotonic()-start,2);results.append(record)
            report={'model':settings.model,'provider':'local_ollama','cases':results,
                'completed_cases':len(results),'planned_cases':len(cases),
                'successful_inferences':sum(r['error_code'] is None for r in results),
                'exact_matches':sum(r['exact_match'] for r in results),
                'limitation':'Synthetic smoke tests do not establish representative appliance-photo accuracy. No production recommendation.'}
            args.output.parent.mkdir(parents=True,exist_ok=True)
            args.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(record),flush=True)
    finally: provider.close()


if __name__=='__main__': main()
