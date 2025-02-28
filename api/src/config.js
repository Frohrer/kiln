const options = {
    sandbox_pool_size: {
        desc: "Maximum number of warm sandboxes to keep in the pool",
        default: 10,
        parser: parse_int,
        validators: [(x) => x > 0 || `${x} cannot be negative`],
    },
}; 