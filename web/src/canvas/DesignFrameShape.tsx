import { useEffect, useState } from 'react';
import { BaseBoxShapeUtil, HTMLContainer, Rectangle2d, T, TLBaseShape } from 'tldraw';
import { api } from '../lib/api';

type DesignFrameShape = TLBaseShape<'design-frame', {
  w: number; h: number; componentId: string; revisionId: string; title: string; publicationId: string;
}>;

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    'design-frame': DesignFrameShape['props'];
  }
}

function RunnableFrame({ revisionId, title }: { revisionId: string; title: string }) {
  const [html, setHtml] = useState(''); const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; setHtml(''); setError(''); api.text(`/api/v1/revisions/${encodeURIComponent(revisionId)}/preview`).then((value) => { if (active) setHtml(value); }).catch((reason) => { if (active) setError(String(reason?.message || reason)); }); return () => { active = false; }; }, [revisionId, attempt]);
  if (error) return <div className="design-frame-empty design-frame-error" role="alert"><span>Preview failed: {error}</span><button onClick={() => setAttempt((value) => value + 1)}>Retry preview</button></div>;
  return html ? <iframe title={title} srcDoc={html} sandbox="allow-scripts"/> : <div className="design-frame-empty">Loading runnable preview…</div>;
}

export class DesignFrameShapeUtil extends BaseBoxShapeUtil<DesignFrameShape> {
  static override type = 'design-frame' as const;
  static override props = { w: T.number, h: T.number, componentId: T.string, revisionId: T.string, title: T.string, publicationId: T.string };
  getDefaultProps(): DesignFrameShape['props'] { return { w: 360, h: 320, componentId: '', revisionId: '', title: 'Runnable design', publicationId: '' }; }
  override getGeometry(shape: DesignFrameShape) { return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true }); }
  component(shape: DesignFrameShape) {
    const preview = shape.props.revisionId ? `/api/v1/revisions/${encodeURIComponent(shape.props.revisionId)}/preview` : '';
    return <HTMLContainer className="design-frame-shape">
      <div className="design-frame-title"><strong>{shape.props.title}</strong><span>runnable React frame</span></div>
      {preview ? <RunnableFrame revisionId={shape.props.revisionId} title={shape.props.title}/> : <div className="design-frame-empty">Build a revision to preview this frame.</div>}
    </HTMLContainer>;
  }
  override getIndicatorPath(shape: DesignFrameShape) { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
}

export const designFrameShapeUtils = [DesignFrameShapeUtil];
