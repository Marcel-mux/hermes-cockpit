import React, { memo, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Platform, Pressable, ScrollView } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';

interface MarkdownViewProps {
  content: string;
  colors: any;
  isDark: boolean;
}

function MarkdownViewImpl({ content, colors, isDark }: MarkdownViewProps) {
  // Parsing runs on every streaming delta otherwise: memoise per content string
  // so unchanged messages are never re-tokenised while another one streams.
  const blocks = useMemo(() => (content ? parseMarkdownBlocks(content) : []), [content]);

  if (!content) return null;

  return (
    <View style={styles.container}>
      {blocks.map((block, idx) => (
        <RenderBlock key={`b-${idx}`} block={block} colors={colors} isDark={isDark} />
      ))}
    </View>
  );
}

export const MarkdownView = memo(MarkdownViewImpl);

type BlockType =
  | { type: 'codeblock'; lang: string; code: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'hr' }
  | { type: 'blockquote'; text: string }
  | { type: 'list-item'; ordered: boolean; prefix: string; text: string }
  | { type: 'paragraph'; text: string };

function parseMarkdownBlocks(raw: string): BlockType[] {
  const lines = raw.split(/\r?\n/);
  const blocks: BlockType[] = [];

  let inCode = false;
  let codeLang = '';
  let codeBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check code fence
    const fenceMatch = line.match(/^```([a-zA-Z0-9_-]*)/);
    if (fenceMatch) {
      if (inCode) {
        // End code block
        blocks.push({
          type: 'codeblock',
          lang: codeLang || 'code',
          code: codeBuffer.join('\n'),
        });
        inCode = false;
        codeLang = '';
        codeBuffer = [];
      } else {
        // Start code block
        inCode = true;
        codeLang = fenceMatch[1] || '';
        codeBuffer = [];
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    // Horizontal rule: --- or ***
    if (/^(---|___|\*\*\*)\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      continue;
    }

    // Heading: #, ##, ###
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      continue;
    }

    // Blockquote: > ...
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      blocks.push({
        type: 'blockquote',
        text: quoteMatch[1],
      });
      continue;
    }

    // List item: - or * or 1.
    const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      blocks.push({
        type: 'list-item',
        ordered: false,
        prefix: '•',
        text: unorderedMatch[2],
      });
      continue;
    }

    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      blocks.push({
        type: 'list-item',
        ordered: true,
        prefix: `${orderedMatch[2]}.`,
        text: orderedMatch[3],
      });
      continue;
    }

    // Normal line / paragraph
    if (line.trim().length > 0) {
      blocks.push({
        type: 'paragraph',
        text: line,
      });
    }
  }

  // Flush remaining open code block if any
  if (inCode && codeBuffer.length > 0) {
    blocks.push({
      type: 'codeblock',
      lang: codeLang || 'code',
      code: codeBuffer.join('\n'),
    });
  }

  return blocks;
}

function RenderBlock({ block, colors, isDark }: { block: BlockType; colors: any; isDark: boolean }) {
  if (block.type === 'hr') {
    return <View style={[styles.hr, { backgroundColor: colors.stroke }]} />;
  }

  if (block.type === 'heading') {
    const fontSize = block.level === 1 ? 16 : block.level === 2 ? 14.5 : 13.5;
    const marginTop = block.level === 1 ? 10 : 6;
    return (
      <Text style={[styles.heading, { color: colors.text, fontSize, marginTop }]}>
        <FormattedInline text={block.text} colors={colors} isDark={isDark} />
      </Text>
    );
  }

  if (block.type === 'blockquote') {
    return (
      <View style={[styles.blockquote, { borderLeftColor: colors.primary, backgroundColor: isDark ? 'rgba(59,130,246,0.08)' : 'rgba(59,130,246,0.05)' }]}>
        <Text style={[styles.blockquoteText, { color: colors.text }]}>
          <FormattedInline text={block.text} colors={colors} isDark={isDark} />
        </Text>
      </View>
    );
  }

  if (block.type === 'list-item') {
    return (
      <View style={styles.listItem}>
        <Text style={[styles.listPrefix, { color: colors.primary }]}>{block.prefix}</Text>
        <Text style={[styles.listText, { color: colors.text }]}>
          <FormattedInline text={block.text} colors={colors} isDark={isDark} />
        </Text>
      </View>
    );
  }

  if (block.type === 'codeblock') {
    return <CodeBlock lang={block.lang} code={block.code} colors={colors} isDark={isDark} />;
  }

  return (
    <Text style={[styles.paragraph, { color: colors.text }]}>
      <FormattedInline text={block.text} colors={colors} isDark={isDark} />
    </Text>
  );
}

function CodeBlock({ lang, code, colors, isDark }: { lang: string; code: string; colors: any; isDark: boolean }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await Clipboard.setStringAsync(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const codeBg = isDark ? '#06090e' : '#f8fafc';
  const headerBg = isDark ? '#0d131d' : '#eef2f6';

  return (
    <View style={[styles.codeBlockWrapper, { borderColor: colors.stroke, backgroundColor: codeBg }]}>
      <View style={[styles.codeHeader, { backgroundColor: headerBg, borderBottomColor: colors.stroke }]}>
        <Text style={[styles.codeLangText, { color: colors.muted }]}>{lang || 'code'}</Text>
        <Pressable onPress={handleCopy} style={styles.copyBtn}>
          <Ionicons name={copied ? 'checkmark-outline' : 'copy-outline'} size={14} color={copied ? colors.good : colors.muted} />
          <Text style={[styles.copyText, { color: copied ? colors.good : colors.muted }]}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={true}
        nestedScrollEnabled
        contentContainerStyle={styles.codeScrollContent}
        style={styles.codeScrollView}
      >
        <Text style={[styles.codeText, { color: isDark ? '#e2e8f0' : '#1e293b' }]} selectable>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

function FormattedInline({ text, colors, isDark }: { text: string; colors: any; isDark: boolean }) {
  if (!text) return null;

  // Tokenize inline markdown: **bold**, *italic*, `code`
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  const parts = text.split(regex);

  const monoFont = Platform.select({
    web: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    default: 'monospace',
  });

  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null;

        // Bold: **text**
        if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
          const inner = part.slice(2, -2);
          return (
            <Text key={`b-${index}`} style={{ fontWeight: '700', color: colors.text }}>
              {inner}
            </Text>
          );
        }

        // Italic: *text*
        if (part.startsWith('*') && part.endsWith('*') && part.length >= 2) {
          const inner = part.slice(1, -1);
          return (
            <Text key={`i-${index}`} style={{ fontStyle: 'italic', color: colors.text }}>
              {inner}
            </Text>
          );
        }

        // Inline Code: `code`
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
          const inner = part.slice(1, -1);
          const inlineBg = isDark ? 'rgba(59,130,246,0.15)' : 'rgba(59,130,246,0.08)';
          return (
            <Text
              key={`c-${index}`}
              style={{
                fontFamily: monoFont,
                fontSize: 12,
                backgroundColor: inlineBg,
                color: colors.primary,
                borderRadius: 4,
                paddingHorizontal: 4,
                paddingVertical: 1,
              }}
            >
              {inner}
            </Text>
          );
        }

        return <Text key={`t-${index}`}>{part}</Text>;
      })}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 5,
    width: '100%',
  },
  paragraph: {
    fontSize: 12.5,
    lineHeight: 18.5,
  },
  heading: {
    fontWeight: '800',
    marginBottom: 3,
  },
  hr: {
    height: 1,
    marginVertical: 8,
    width: '100%',
  },
  blockquote: {
    borderLeftWidth: 3,
    paddingLeft: 10,
    paddingVertical: 3,
    borderRadius: 4,
    marginVertical: 3,
  },
  blockquoteText: {
    fontSize: 12,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    marginVertical: 1.5,
    paddingLeft: 3,
  },
  listPrefix: {
    fontSize: 12.5,
    lineHeight: 18.5,
    fontWeight: '700',
  },
  listText: {
    flex: 1,
    fontSize: 12.5,
    lineHeight: 18.5,
  },
  codeBlockWrapper: {
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
    marginVertical: 6,
    width: '100%',
  },
  codeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  codeLangText: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  copyText: {
    fontSize: 10,
    fontWeight: '600',
  },
  codeScrollView: {
    width: '100%',
  },
  codeScrollContent: {
    padding: 10,
    minWidth: '100%',
  },
  codeText: {
    fontSize: 11.5,
    lineHeight: 17,
    fontFamily: Platform.select({
      web: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      default: 'monospace',
    }),
  },
});
