/**
 * semantic-release configuration
 *
 * Protected-branch-safe workflow:
 * - semantic-release determines the next version from conventional commits
 * - @semantic-release/npm updates package.json/package-lock.json in the CI workspace
 *   and publishes the package to GitHub Packages
 * - @semantic-release/github creates the tag and GitHub release
 * - the Actions workflow packages and uploads the tarball after the version bump,
 *   so the shipped CLI artifact reports the released version via package.json
 *
 * No changelog commits or git write-back to main.
 */
export default {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    '@semantic-release/npm',
    '@semantic-release/github',
  ],
};
