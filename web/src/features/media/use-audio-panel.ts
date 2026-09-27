import { useLayoutEffect, useRef } from 'react';
import { useResizable } from '@astryxdesign/core/Resizable';

export function useAudioPanel(hasTrack: boolean, autoSaveId?: string) {
  const minSize = hasTrack ? 148 : 100;
  const panel = useResizable({ direction: 'vertical', defaultSize: minSize, minSize, maxSize: 600, autoSaveId });
  const previousMin = useRef(minSize);
  useLayoutEffect(() => {
    // 删除最后一轨时收回行高，手动拉大的面板保留原高度。
    if (minSize < previousMin.current && panel.size <= previousMin.current) panel.resize(minSize);
    previousMin.current = minSize;
  }, [minSize, panel.size, panel.resize]);
  return panel;
}
