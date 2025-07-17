module.exports = {
    apps: [
        {
            name: "media-library-source-worker",
            script: "./src/main.js",
            args: "worker",
            // instances: "max",
            // instances: 5,
            instances: 1,
            env: {
                NODE_ENV: "development",
            },
            env_production: {
                NODE_ENV: "production",
            },
        },
    ],
};
