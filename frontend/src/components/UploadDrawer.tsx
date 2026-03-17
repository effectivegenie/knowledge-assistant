import { useState } from 'react';
import { Button, Drawer, Select, Space, Typography, Upload, message } from 'antd';
import type { UploadFile } from 'antd';
import { UploadOutlined, InboxOutlined } from '@ant-design/icons';
import { adminApiUrl } from '../config';

const { Dragger } = Upload;
const { Text } = Typography;

const BUSINESS_GROUPS = [
  'financial', 'accounting', 'operations', 'marketing', 'IT',
  'warehouse', 'security', 'logistics', 'sales', 'design', 'HR',
];

const DOCUMENT_TAG_OPTIONS = [
  { label: 'general — достъпни за всички', value: 'general' },
  ...BUSINESS_GROUPS.map(g => ({ label: g, value: g })),
];

const ACCEPTED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/html', 'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
]);
const ACCEPTED_EXT = /\.(pdf|docx?|txt|md|html?|csv|xlsx?|pptx?|jpe?g|png|gif|webp|tiff?|bmp)$/i;

const DRAWER_STYLES = {
  header: { background: '#1e3a5f', borderBottom: '2px solid #e6a800', padding: '16px 20px' },
  body:   { paddingTop: 24 },
  footer: { borderTop: '1px solid #f0f4fb' },
};

const CATEGORY_OPTIONS = [
  { value: 'general',  label: 'Общи — само база знания' },
  { value: 'invoice',  label: 'Фактури — база знания + обработка на фактури' },
  { value: 'contract', label: 'Договори — база знания + обработка на договори' },
];

const CYRILLIC_MAP: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ж': 'zh',
  'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n',
  'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f',
  'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sht', 'ъ': 'a',
  'ь': '', 'ю': 'yu', 'я': 'ya',
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ж': 'Zh',
  'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N',
  'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U', 'Ф': 'F',
  'Х': 'H', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Sht', 'Ъ': 'A',
  'Ь': '', 'Ю': 'Yu', 'Я': 'Ya',
};

function transliterateFilename(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  const ext  = lastDot >= 0 ? filename.slice(lastDot) : '';
  const base = lastDot >= 0 ? filename.slice(0, lastDot) : filename;
  const latin = base.split('').map(c => CYRILLIC_MAP[c] ?? c).join('');
  const clean = latin.replace(/[^\w.-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return (clean || 'file') + ext;
}

export interface UploadDrawerProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  tenantId: string;
  idToken: string | null;
  /** If provided, category is pre-selected and the selector is disabled */
  lockedCategory?: 'general' | 'invoice' | 'contract';
}

export default function UploadDrawer({
  open, onClose, onSuccess, tenantId, idToken, lockedCategory,
}: UploadDrawerProps) {
  const [fileList, setFileList]   = useState<UploadFile[]>([]);
  const [groups, setGroups]       = useState<string[]>([]);
  const [category, setCategory]   = useState<'general' | 'invoice' | 'contract'>(lockedCategory ?? 'general');
  const [uploading, setUploading] = useState(false);

  const reset = () => {
    setFileList([]);
    setGroups([]);
    setCategory(lockedCategory ?? 'general');
    onClose();
  };

  const handleUpload = async () => {
    if (fileList.length === 0) return;
    setUploading(true);
    let successCount = 0;

    for (const fileWrapper of fileList) {
      const f = fileWrapper as unknown as File;
      const safeFilename = transliterateFilename(f.name);
      try {
        const effectiveGroups = groups.length > 0 ? groups : ['general'];
        const res = await fetch(`${adminApiUrl}/tenants/${encodeURIComponent(tenantId)}/upload-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ filename: safeFilename, groups: effectiveGroups, category }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
        const { url, metadataUrl } = data;

        const metadata = JSON.stringify({ metadataAttributes: { tenantId, groups: effectiveGroups, category } });
        const metaRes = await fetch(metadataUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: metadata,
        });
        if (!metaRes.ok) throw new Error('Грешка при качване на метаданни');

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.onload = () => (xhr.status === 200 || xhr.status === 204) ? resolve() : reject(new Error(`S3 upload failed: ${xhr.status}`));
          xhr.onerror = () => reject(new Error('Network error'));
          xhr.open('PUT', url);
          xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
          xhr.send(f);
        });

        successCount++;
      } catch (e) {
        message.error(`${f.name}: ${e instanceof Error ? e.message : 'Грешка при качване'}`);
      }
    }

    setUploading(false);
    if (successCount > 0) {
      message.success(`${successCount} файл${successCount !== 1 ? 'а' : ''} качен`);
      reset();
      onSuccess();
    }
  };

  return (
    <Drawer
      title={<span style={{ color: '#fff', fontWeight: 700 }}>Качи документи</span>}
      placement="right"
      open={open}
      onClose={reset}
      width={440}
      closeIcon={<span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>✕</span>}
      styles={DRAWER_STYLES}
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={reset} disabled={uploading}>Отказ</Button>
          <Button
            type="primary"
            icon={<UploadOutlined />}
            loading={uploading}
            disabled={fileList.length === 0}
            onClick={handleUpload}
          >
            Качи{fileList.length > 0 ? ` (${fileList.length})` : ''}
          </Button>
        </Space>
      }
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        Файловете се качват в базата знания на <strong>{tenantId}</strong> и се индексират автоматично.
      </Text>

      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ display: 'block', marginBottom: 6 }}>Категория</Text>
        <Select
          value={category}
          onChange={v => setCategory(v)}
          disabled={!!lockedCategory}
          style={{ width: '100%' }}
          options={CATEGORY_OPTIONS}
        />
      </div>

      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ display: 'block', marginBottom: 6 }}>Групи за достъп</Text>
        <Select
          mode="multiple"
          options={DOCUMENT_TAG_OPTIONS}
          value={groups}
          onChange={setGroups}
          placeholder="Избери групи (оставете празно за достъп от всички)"
          style={{ width: '100%' }}
          allowClear
        />
      </div>

      <Dragger
        multiple
        fileList={fileList}
        beforeUpload={(file) => {
          const valid = ACCEPTED_MIME.has(file.type) || ACCEPTED_EXT.test(file.name);
          if (!valid) {
            message.error(`${file.name}: неподдържан формат`);
            return Upload.LIST_IGNORE;
          }
          setFileList(prev => [...prev, file as unknown as UploadFile]);
          return false;
        }}
        onRemove={(file) => {
          setFileList(prev => prev.filter(f => f.uid !== file.uid));
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined style={{ color: '#1e3a5f', fontSize: 48 }} />
        </p>
        <p className="ant-upload-text">Кликни или провлачи файлове тук</p>
        <p className="ant-upload-hint">PDF, Word, Excel, PowerPoint, CSV, Markdown, текст, изображения</p>
      </Dragger>
    </Drawer>
  );
}
