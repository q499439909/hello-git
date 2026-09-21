import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Braces,
  Download,
  File,
  FileText,
  Image as ImageIcon,
  RefreshCw,
  Table2,
} from "lucide-react";
import { artifactApi } from "./lib/artifact-api";
import type { ArtifactItem, PreviewDescriptor, RecordsPreview } from "./lib/artifact-api";

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}

function iconFor(kind: ArtifactItem["kind"]) {
  if (kind === "image") return <ImageIcon size={20} />;
  if (kind === "json") return <Braces size={20} />;
  if (kind === "jsonl" || kind === "parquet") return <Table2 size={20} />;
  if (kind === "text") return <FileText size={20} />;
  return <File size={20} />;
}

export function ArtifactLibrary({ appId, projectName, apiBaseUrl, onClose }: {
  appId: string;
  projectName: string;
  apiBaseUrl?: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [selected, setSelected] = useState<ArtifactItem | null>(null);
  const [descriptor, setDescriptor] = useState<PreviewDescriptor | null>(null);
  const [preview, setPreview] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadTokenRef = useRef(0);

  const load = async () => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    setError("");
    try {
      await artifactApi.initializeProject(appId, projectName, apiBaseUrl);
      const result = await artifactApi.list(appId, apiBaseUrl);
      if (token !== loadTokenRef.current) return;
      setItems(result.items);
    } catch (reason) {
      if (token !== loadTokenRef.current) return;
      setError(reason instanceof Error ? reason.message : "无法读取项目输出");
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    setItems([]);
    setSelected(null);
    setDescriptor(null);
    setPreview(null);
    setError("");
    void load();
    return () => { loadTokenRef.current += 1; };
  }, [appId, projectName, apiBaseUrl]);

  const open = async (item: ArtifactItem) => {
    setSelected(item);
    setDescriptor(null);
    setPreview(null);
    setError("");
    try {
      const next = await artifactApi.descriptor(item.id, apiBaseUrl);
      setDescriptor(next);
      if (next.viewer === "json") setPreview(await artifactApi.json(item.id, apiBaseUrl));
      if (next.viewer === "table") setPreview(await artifactApi.records(item.id, 0, apiBaseUrl));
      if (next.viewer === "text") setPreview(await artifactApi.text(item.id, apiBaseUrl));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法生成预览");
    }
  };

  const groups = useMemo(() => ({
    data: items.filter((item) => ["json", "jsonl", "parquet", "text"].includes(item.kind)),
    images: items.filter((item) => item.kind === "image"),
    other: items.filter((item) => item.kind === "binary"),
  }), [items]);

  return (
    <section className="artifact-page">
      <div className="artifact-page-head">
        <div>
          <button className="artifact-back" onClick={onClose}><ArrowLeft size={17} />返回会话</button>
          <h1>项目输出</h1>
          <p>{projectName} · 运行生成的 JSON、数据文件和图片</p>
        </div>
        <button className="quiet-button" onClick={() => void load()}><RefreshCw size={15} />刷新</button>
      </div>

      {error && <div className="artifact-error">{error}</div>}
      {loading ? <div className="artifact-empty">正在读取项目输出…</div> : !items.length ? (
        <div className="artifact-empty">
          <File size={30} />
          <strong>还没有处理输出</strong>
          <span>完成一次 Run 并提交后，JSON、Parquet 和图片会显示在这里。</span>
        </div>
      ) : (
        <div className="artifact-layout">
          <div className="artifact-list">
            <ArtifactGroup title="数据与文档" items={groups.data} selected={selected} onOpen={open} />
            <ArtifactGroup title="图片" items={groups.images} selected={selected} onOpen={open} />
            <ArtifactGroup title="其他文件" items={groups.other} selected={selected} onOpen={open} />
          </div>
          <div className="artifact-preview">
            {!selected ? <div className="artifact-preview-placeholder">选择一个输出查看内容</div> : (
              <>
                <div className="artifact-preview-head">
                  <div><strong>{selected.name}</strong><span>{selected.format.toUpperCase()} · {formatBytes(selected.byte_size)}</span></div>
                  {descriptor && <a href={artifactApi.absolute(descriptor.download_url, apiBaseUrl)} download><Download size={16} />下载</a>}
                </div>
                <Preview descriptor={descriptor} value={preview} apiBaseUrl={apiBaseUrl} />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ArtifactGroup({ title, items, selected, onOpen }: {
  title: string;
  items: ArtifactItem[];
  selected: ArtifactItem | null;
  onOpen: (item: ArtifactItem) => void;
}) {
  if (!items.length) return null;
  return <div className="artifact-group">
    <h2>{title}<span>{items.length}</span></h2>
    {items.map((item) => (
      <button key={item.id} className={selected?.id === item.id ? "active" : ""} onClick={() => void onOpen(item)}>
        <span className={`artifact-kind ${item.kind}`}>{iconFor(item.kind)}</span>
        <span><strong>{item.name}</strong><small>{item.format.toUpperCase()} · {formatBytes(item.byte_size)}</small></span>
      </button>
    ))}
  </div>;
}

function Preview({ descriptor, value, apiBaseUrl }: {
  descriptor: PreviewDescriptor | null;
  value: unknown;
  apiBaseUrl?: string;
}) {
  if (!descriptor) return <div className="artifact-preview-placeholder">正在生成预览…</div>;
  if (descriptor.viewer === "image") {
    return <div className="image-preview"><img src={artifactApi.absolute(descriptor.thumbnail_url || descriptor.content_url, apiBaseUrl)} alt={descriptor.name} /></div>;
  }
  if (descriptor.viewer === "json") {
    return <pre className="json-preview">{JSON.stringify(value, null, 2)}</pre>;
  }
  if (descriptor.viewer === "text") {
    const payload = value as { text?: string; has_more?: boolean } | null;
    return <div className="text-preview"><pre>{payload?.text || ""}</pre>{payload?.has_more && <small>内容过长，仅显示前 256 KB</small>}</div>;
  }
  if (descriptor.viewer === "table") return <RecordsTable value={value as RecordsPreview | null} />;
  return <div className="artifact-preview-placeholder"><File size={30} /><strong>此格式暂不支持在线预览</strong><span>可以下载原始文件。</span></div>;
}

function RecordsTable({ value }: { value: RecordsPreview | null }) {
  if (!value) return <div className="artifact-preview-placeholder">正在读取记录…</div>;
  return <div className="records-wrap"><table><thead><tr>{value.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>
    {value.rows.map((row, index) => <tr key={index}>{value.columns.map((column) => {
      const cell = row[column];
      return <td key={column}>{typeof cell === "object" ? JSON.stringify(cell) : String(cell ?? "")}</td>;
    })}</tr>)}
  </tbody></table>{value.has_more && <small>当前显示前 {value.limit} 条记录</small>}</div>;
}
