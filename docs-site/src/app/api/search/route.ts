import { source } from '@/lib/source';
import { createSearchAPI } from 'fumadocs-core/search/server';

export const { GET } = createSearchAPI('simple', {
  indexes: source.getPages().map((page) => ({
    title: page.data.title ?? page.slugs.at(-1) ?? 'Untitled',
    description: page.data.description,
    content: '',
    url: page.url,
  })),
});
