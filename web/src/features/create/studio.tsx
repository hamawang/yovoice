import type { ReactNode } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { useTranslator } from '@astryxdesign/core/i18n';
import { SlidersHorizontal } from 'lucide-react';

export function Studio({ title, actions, inspector, showInspector, onShowInspector, writingClassName = '', children }: {
  title: ReactNode; actions?: ReactNode; inspector: ReactNode; showInspector: boolean;
  onShowInspector: () => void; writingClassName?: string; children: ReactNode;
}) {
  const t = useTranslator();
  return <HStack className={`studio ${showInspector ? 'show-inspector' : ''}`} gap={0}>
    <VStack as="section" className="document" gap={0}>
      <VStack className={`writing ${writingClassName}`} gap={0}>
        <HStack className="document-heading" gap={3} vAlign="center">
          {title}{actions}
          <Button label={t('@yovoice.app.voiceSettings')} className="inspector-toggle" isIconOnly icon={<SlidersHorizontal />} variant="ghost" onClick={onShowInspector} />
        </HStack>
        {children}
      </VStack>
    </VStack>
    {inspector}
  </HStack>;
}
