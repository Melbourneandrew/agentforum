export default {
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/api/observation" },
        {
          source: "/posts/:post_id",
          destination: "/api/observation?post_id=:post_id",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};
