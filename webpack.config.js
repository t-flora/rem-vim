const { resolve } = require('path');
const glob = require('glob');
const path = require('path');

const HtmlWebpackPlugin = require('html-webpack-plugin');
const { ESBuildMinifyPlugin } = require('esbuild-loader');
const { ProvidePlugin, BannerPlugin, DefinePlugin } = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const isProd = process.env.NODE_ENV === 'production';

// Webpack-process start time, the `@…` half of the debug badge's first token.
// Evaluated once per process (npm run dev / npm run build) — NOT re-evaluated
// on incremental dev-server rebuilds, since webpack.config.js is only
// require()'d once. The *version* half of that token is different: adapter.ts
// imports it straight from package.json as a module, so bumping the version
// reaches a still-running dev server on the next incremental rebuild — which
// is why the version MUST be bumped every change round (see CLAUDE.md).
const BUILD_TIME = new Date().toISOString().slice(0, 19);

// RemNote loads each widget twice: once as a module (needs IMPORT_META shim)
// and once inside the sandbox iframe via index.html?widgetName=<name>.
const SANDBOX_SUFFIX = '-sandbox';

const config = {
  mode: isProd ? 'production' : 'development',
  entry: glob.sync('./src/widgets/**/*.tsx').reduce((obj, el) => {
    const rel = path
      .relative('src/widgets', el)
      .replace(/\.[tj]sx?$/, '')
      .replace(/\\/g, '/');
    obj[rel] = el;
    obj[`${rel}${SANDBOX_SUFFIX}`] = el;
    return obj;
  }, {}),

  output: {
    path: resolve(__dirname, 'dist'),
    filename: `[name].js`,
    publicPath: '',
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
  },
  module: {
    rules: [
      {
        test: /\.(ts|tsx|jsx|js)?$/,
        loader: 'esbuild-loader',
        options: {
          loader: 'tsx',
          target: 'es2020',
          minify: false,
        },
      },
    ],
  },
  plugins: [
    new DefinePlugin({
      __VIM_BUILD__: JSON.stringify(BUILD_TIME),
    }),
    new HtmlWebpackPlugin({
      templateContent: `
      <body></body>
      <script type="text/javascript">
      const urlSearchParams = new URLSearchParams(window.location.search);
      const queryParams = Object.fromEntries(urlSearchParams.entries());
      const widgetName = queryParams["widgetName"];
      if (widgetName == undefined) {document.body.innerHTML+="Widget ID not specified."}

      const s = document.createElement('script');
      s.type = "module";
      s.src = widgetName+"${SANDBOX_SUFFIX}.js";
      document.body.appendChild(s);
      </script>
    `,
      filename: 'index.html',
      inject: false,
    }),
    new ProvidePlugin({
      React: 'react',
      reactDOM: 'react-dom',
    }),
    new BannerPlugin({
      banner: (file) => {
        return !file.chunk.name.includes(SANDBOX_SUFFIX) ? 'const IMPORT_META=import.meta;' : '';
      },
      raw: true,
    }),
    new CopyPlugin({
      // public/ holds manifest.json; RemNote's plugin store also requires a
      // README.md in the zip root, so bundle the repo's root README too.
      patterns: [
        { from: 'public', to: '' },
        { from: 'README.md', to: '' },
      ],
    }),
  ].filter(Boolean),
};

if (isProd) {
  config.optimization = {
    minimize: true,
    minimizer: [new ESBuildMinifyPlugin()],
  };
} else {
  config.devServer = {
    port: 8080,
    open: false,
    hot: false,
    liveReload: false,
    compress: true,
    webSocketServer: false,
    client: false,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'baggage, sentry-trace',
    },
  };
}

module.exports = config;
