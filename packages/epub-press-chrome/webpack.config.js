const path = require('path');
const webpack = require('webpack');

const MODULE_RULES = [
    {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        loader: 'babel-loader',
    },
];

let WebpackConfig;
if (process.env.ENV !== 'test') {
    WebpackConfig = {
        mode: 'production',
        entry: {
            popup: ['./scripts/popup.js'],
            service: ['./scripts/service.js'],
        },
        output: {
            filename: '[name].js',
            path: path.join(__dirname, 'app', 'build'),
        },
        optimization: {
            minimize: false,
        },
        module: {
            rules: MODULE_RULES,
        },
        plugins: [
            new webpack.DefinePlugin({
                'process.env.ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
            }),
            new webpack.ProvidePlugin({
                $: 'jquery',
                jQuery: 'jquery',
            }),
        ],
        resolve: {
            extensions: ['.js'],
            fallback: {
              fs: false
            }
        },
        devServer: {
            hostname: 'localhost',
            port: '5000',
            inline: true,
        },
    };
} else {
    WebpackConfig = {
        mode: 'development',
        entry: ['fetch-mock', 'mocha-loader!./tests/index.js'],
        output: {
            filename: 'test.build.js',
            path: path.join(__dirname, 'tests'),
        },
        module: {
            rules: MODULE_RULES,
        },
        plugins: [
            new webpack.DefinePlugin({
                'process.env.ENV': JSON.stringify(process.env.NODE_ENV || 'test'),
            }),
        ],
        resolve: {
            extensions: ['.js'],
            fallback: {
              fs: false
            }
        },
        devServer: {
            port: '5001',
            inline: true,
        },
    };
}

module.exports = WebpackConfig;
