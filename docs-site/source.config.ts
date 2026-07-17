import { defineDocs, getDefaultMDXOptions } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // All content is plain Markdown synced from autobot-inbox/docs and spec/
    // (see scripts/prebuild.sh) — never authored as MDX. Parsing it as MDX
    // treats literal `{}` / `<...>` as JSX, which breaks several spec files
    // and sends the Next.js compile worker into an OOM death spiral.
    mdxOptions: getDefaultMDXOptions({ format: 'md' }),
  },
});
