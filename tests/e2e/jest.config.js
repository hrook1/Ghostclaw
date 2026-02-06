export default {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  verbose: true,
  testTimeout: 300000, // 5 minutes for proof generation
  setupFilesAfterEnv: ['./setup.js'],
  moduleFileExtensions: ['js', 'json'],
  collectCoverageFrom: [
    '**/*.js',
    '!**/node_modules/**',
    '!**/coverage/**'
  ]
};
