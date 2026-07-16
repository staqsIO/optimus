import { fetchWithTimeout } from '../../runtime/fetch-utils.js';

/**
 * GitHub repo normalizer: reads README + key files via GitHub API,
 * returns normalized document for RAG ingestion.
 */
export async function normalizeGithubRepo(repoUrl) {
  // Parse owner/repo from URL
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${repoUrl}`);
  const [, owner, repo] = match;
  const cleanRepo = repo.replace(/\.git$/, '');

  const headers = { 'User-Agent': 'Optimus-RAG/1.0' };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
  }

  // Fetch repo metadata
  const repoRes = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${cleanRepo}`, { headers });
  if (!repoRes.ok) throw new Error(`GitHub API error: ${repoRes.status}`);
  const repoData = await repoRes.json();

  // Fetch README
  let readme = '';
  try {
    const readmeRes = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${cleanRepo}/readme`, { headers });
    if (readmeRes.ok) {
      const readmeData = await readmeRes.json();
      readme = Buffer.from(readmeData.content, 'base64').toString('utf-8');
    }
  } catch { /* no readme */ }

  const content = [
    `# ${repoData.full_name}`,
    repoData.description ? `\n${repoData.description}` : '',
    `\nStars: ${repoData.stargazers_count} | Forks: ${repoData.forks_count} | Language: ${repoData.language || 'unknown'}`,
    readme ? `\n---\n\n${readme}` : '',
  ].join('\n');

  return {
    title: repoData.full_name,
    content: content.slice(0, 100000),
    source: 'github',
    metadata: {
      url: repoUrl,
      owner,
      repo: cleanRepo,
      stars: repoData.stargazers_count,
      language: repoData.language,
      fetched_at: new Date().toISOString(),
    },
  };
}
