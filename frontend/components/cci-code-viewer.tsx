'use client';

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus';
import type { RefObject } from 'react';

interface CciCodeViewerProps {
    content: string;
    lang: string;
    lineStart: number;
    lineEnd: number;
    lineRef: RefObject<HTMLDivElement | null>;
}

/** Lazy-loaded Prism code viewer for cci:// file preview modal. */
export function CciCodeViewer({ content, lang, lineStart, lineEnd, lineRef }: CciCodeViewerProps) {
    return (
        <SyntaxHighlighter
            language={lang}
            style={vscDarkPlus}
            showLineNumbers
            startingLineNumber={1}
            wrapLines
            lineProps={(lineNumber: number) => {
                const isHighlighted = lineNumber >= lineStart && lineNumber <= lineEnd;
                return {
                    ref: lineNumber === lineStart ? lineRef : undefined,
                    style: {
                        display: 'block',
                        backgroundColor: isHighlighted ? 'rgba(255,220,100,0.08)' : undefined,
                        borderLeft: isHighlighted ? '2px solid rgba(255,220,100,0.5)' : '2px solid transparent',
                    },
                };
            }}
            customStyle={{
                margin: 0,
                borderRadius: 0,
                background: 'transparent',
                fontSize: '12px',
                lineHeight: '1.6',
            }}
            codeTagProps={{ style: { fontFamily: 'var(--font-mono, monospace)' } }}
        >
            {content}
        </SyntaxHighlighter>
    );
}
