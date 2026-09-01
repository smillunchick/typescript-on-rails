/** @type {import('next').NextConfig} */
const config = { output: "standalone", serverExternalPackages: ["typescript-on-rails", "@typescript-on-rails/postgres", "@typescript-on-rails/jobs"] };
export default config;
