const logger = require("logplease").create("runtime");
const semver = require("semver");
const config = require("./config");
const globals = require("./globals");
const fss = require("fs");
const path = require("path");

const runtimes = [];

class Runtime {
	constructor({ language, version, aliases, pkgdir, runtime, timeouts, cpu_times, memory_limits, max_process_count, max_open_files, max_file_size, output_max_size, vmImage }) {
		this.language = language;
		this.version = version;
		this.aliases = aliases || [];
		this.pkgdir = pkgdir;
		this.runtime = runtime;
		this.timeouts = timeouts;
		this.cpu_times = cpu_times;
		this.memory_limits = memory_limits;
		this.max_process_count = max_process_count;
		this.max_open_files = max_open_files;
		this.max_file_size = max_file_size;
		this.output_max_size = output_max_size;
		this.vmImage = vmImage;
		this.available = this.checkImageAvailability();
	}

	checkImageAvailability() {
		if (!this.vmImage) return false;
		try {
			return fss.existsSync(this.vmImage);
		} catch (error) {
			logger.error(`Error checking image availability for ${this.language}-${this.version.raw}: ${error}`);
			return false;
		}
	}

	toJSON() {
		return {
			language: this.language,
			version: this.version.raw,
			aliases: this.aliases,
			runtime: this.runtime,
			available: this.available,
			vmImage: path.basename(this.vmImage || '')
		};
	}

	static compute_single_limit(language_name, limit_name, language_limit_overrides) {
		return (config.limit_overrides[language_name] && config.limit_overrides[language_name][limit_name]) || (language_limit_overrides && language_limit_overrides[limit_name]) || config[limit_name];
	}

	static compute_all_limits(language_name, language_limit_overrides) {
		return {
			timeouts: {
				compile: this.compute_single_limit(language_name, "compile_timeout", language_limit_overrides),
				run: this.compute_single_limit(language_name, "run_timeout", language_limit_overrides),
			},
			cpu_times: {
				compile: this.compute_single_limit(language_name, "compile_cpu_time", language_limit_overrides),
				run: this.compute_single_limit(language_name, "run_cpu_time", language_limit_overrides),
			},
			memory_limits: {
				compile: this.compute_single_limit(language_name, "compile_memory_limit", language_limit_overrides),
				run: this.compute_single_limit(language_name, "run_memory_limit", language_limit_overrides),
			},
			max_process_count: this.compute_single_limit(language_name, "max_process_count", language_limit_overrides),
			max_open_files: this.compute_single_limit(language_name, "max_open_files", language_limit_overrides),
			max_file_size: this.compute_single_limit(language_name, "max_file_size", language_limit_overrides),
			output_max_size: this.compute_single_limit(language_name, "output_max_size", language_limit_overrides),
		};
	}

	static load_package(pkgdir) {
		try {
			const pkg_json_path = path.join(pkgdir, globals.pkg_installed_file);
			logger.debug(`Looking for manifest at: ${pkg_json_path}`);
			logger.debug(`Manifest filename from globals: ${globals.pkg_installed_file}`);
			
			// Check if directory exists
			if (!fss.existsSync(pkgdir)) {
				logger.error(`Package directory does not exist: ${pkgdir}`);
				throw new Error(`Package directory not found at ${pkgdir}`);
			}
			
			// List contents of directory
			try {
				const dirContents = fss.readdirSync(pkgdir);
				logger.debug(`Contents of ${pkgdir}:`, dirContents);
			} catch (error) {
				logger.error(`Failed to read directory ${pkgdir}:`, error);
			}
			
			if (!fss.existsSync(pkg_json_path)) {
				logger.error(`Manifest file not found at ${pkg_json_path}`);
				throw new Error(`Package manifest not found at ${pkg_json_path}`);
			}

			const pkg_json = JSON.parse(fss.readFileSync(pkg_json_path));
			logger.debug(`Successfully read manifest:`, pkg_json);
			const version = semver.parse(pkg_json.version);
			if (!version) {
				throw new Error(`Invalid version ${pkg_json.version}`);
			}

			const limits = Runtime.compute_all_limits(pkg_json.language, pkg_json.limits);
			const runtime = new Runtime({
				language: pkg_json.language,
				version,
				aliases: pkg_json.aliases,
				pkgdir,
				runtime: pkg_json.runtime,
				...limits,
				vmImage: pkgdir.endsWith('.ext4') ? pkgdir : null
			});

			// Only register if the image is available
			if (runtime.available) {
				runtimes.push(runtime);
				logger.info(`Registered runtime ${runtime.language}-${runtime.version.raw}`);
			} else {
				logger.warn(`Skipping unavailable runtime ${runtime.language}-${runtime.version.raw}`);
			}
		} catch (error) {
			logger.error(`Failed to load package at ${pkgdir}:`, error);
		}
	}

	get compiled() {
		if (this._compiled === undefined) {
			this._compiled = fss.exists_sync(path.join(this.pkgdir, "compile"));
		}

		return this._compiled;
	}

	get env_vars() {
		if (!this._env_vars) {
			const env_file = path.join(this.pkgdir, ".env");
			const env_content = fss.read_file_sync(env_file).toString();

			this._env_vars = {};

			env_content
				.trim()
				.split("\n")
				.map((line) => line.split("=", 2))
				.forEach(([key, val]) => {
					this._env_vars[key.trim()] = val.trim();
				});
		}

		return this._env_vars;
	}

	toString() {
		return `${this.language}-${this.version.raw}`;
	}

	unregister() {
		const index = runtimes.indexOf(this);
		runtimes.splice(index, 1); //Remove from runtimes list
	}
}

module.exports = {
	runtimes,
	Runtime,
	get_runtimes_matching_language_version: function (lang, ver) {
		return runtimes.filter((rt) => (rt.language == lang || rt.aliases.includes(lang)) && semver.satisfies(rt.version, ver));
	},
	get_latest_runtime_matching_language_version: function (lang, ver) {
		return module.exports.get_runtimes_matching_language_version(lang, ver).sort((a, b) => semver.rcompare(a.version, b.version))[0];
	},
	get_runtime_by_name_and_version: function (runtime, ver) {
		return runtimes.find((rt) => (rt.runtime == runtime || (rt.runtime === undefined && rt.language == runtime)) && semver.satisfies(rt.version, ver));
	},
	get_available_runtimes: function () {
		return runtimes.filter(rt => rt.available);
	},
	load_package: Runtime.load_package,
	map: runtimes
};
