import { describe, expect, it } from 'vitest';
import { latinPersonName } from '../src/domain/latin-name';

describe('recipient names in English addresses', () => {
  it('writes Chinese names in Hanyu Pinyin with surname readings', () => {
    expect(latinPersonName('CN', '张伟', '张', '伟')).toBe('Zhang Wei');
    expect(latinPersonName('CN', '曾子涵', '曾', '子涵')).toBe('Zeng Zihan');
    expect(latinPersonName('CN', '欧阳天宇', '欧阳', '天宇')).toBe('Ouyang Tianyu');
    expect(latinPersonName('CN', '吕西安', '吕', '西安')).toBe("Lyu Xi'an");
    expect(latinPersonName('TW', '陳嘉懿', '陳', '嘉懿')).toBe('Chen Jia-yi');
    expect(latinPersonName('TW', '單博文', '單', '博文')).toBe('Shan Bo-wen');
  });

  it('writes Korean names in the Revised Romanization with customary surnames', () => {
    expect(latinPersonName('KR', '김민준', '김', '민준')).toBe('Kim Min-jun');
    expect(latinPersonName('KR', '이하람', '이', '하람')).toBe('Lee Ha-ram');
    expect(latinPersonName('KR', '탁윤', '탁', '윤')).toBe('Tak Yun');
    expect(latinPersonName('KR', '황은성', '황', '은성')).toBe('Hwang Eun-seong');
  });

  it('transliterates Russian names and leaves names without a reliable reading', () => {
    expect(latinPersonName('RU', 'Юлия Щербакова', 'Щербакова', 'Юлия')).toBe('Yuliya Shcherbakova');
    expect(latinPersonName('JP', '成田 敏子', '成田', '敏子')).toBeUndefined();
    expect(latinPersonName('TH', 'สมชาย ใจดี', 'ใจดี', 'สมชาย')).toBeUndefined();
    expect(latinPersonName('US', 'Ann Lee', 'Lee', 'Ann')).toBeUndefined();
  });
});
