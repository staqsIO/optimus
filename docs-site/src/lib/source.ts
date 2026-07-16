import { docs } from '../../.source';
import { loader } from 'fumadocs-core/source';

const fumadocsSource = docs.toFumadocsSource();

// fumadocs-mdx@11 returns files as a lazy function, fumadocs-core@15 expects an array
const files = typeof fumadocsSource.files === 'function'
  ? (fumadocsSource.files as () => any[])()
  : fumadocsSource.files;

export const source = loader({
  baseUrl: '/docs',
  source: { ...fumadocsSource, files },
});
