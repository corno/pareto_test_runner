const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');

const failedTransformers = [];
const packageCoverageResults = [];
const coverageRoot = path.join(__dirname, '.coverage');
const c8Binary = path.join(__dirname, 'node_modules', '.bin', 'c8');

function sanitizeLabel(label) {
	return label.replace(/^\//, '').replace(/[\\/]/g, '__') || 'root';
}

function directoriesIn(directory) {
	if (!fs.existsSync(directory)) {
		return [];
	}

	return fs.readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function filesIn(directory) {
	if (!fs.existsSync(directory)) {
		return [];
	}

	return fs.readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.name !== '.liana')
		.sort((left, right) => left.name.localeCompare(right.name))
		.flatMap((entry) => {
			const entryPath = path.join(directory, entry.name);
			return entry.isDirectory() ? filesIn(entryPath) : [entryPath];
		});
}

function projectDirectories(root) {
	return directoriesIn(path.join(root, 'versions')).length > 0
		? [root]
		: directoriesIn(root).map((name) => path.join(root, name));
}

function resultDirectoriesMatch(actualDirectory, expectedDirectory) {
	if (!fs.existsSync(expectedDirectory) || !fs.statSync(expectedDirectory).isDirectory()) {
		return false;
	}

	const actualFiles = filesIn(actualDirectory);
	const expectedFiles = filesIn(expectedDirectory);
	if (actualFiles.length !== expectedFiles.length) {
		return false;
	}

	for (const actualFile of actualFiles) {
		const relativePath = path.relative(actualDirectory, actualFile);
		const expectedFile = path.join(expectedDirectory, relativePath);
		if (!fs.existsSync(expectedFile) || !fs.readFileSync(actualFile).equals(fs.readFileSync(expectedFile))) {
			return false;
		}
	}

	return true;
}

function buildTransformer(transformerVersionDirectory) {
	if (!fs.existsSync(path.join(transformerVersionDirectory, 'tsconfig.json'))) {
		return true;
	}

	const result = spawnSync('tsc', [], { cwd: transformerVersionDirectory, encoding: 'utf8' });
	if (result.error || result.status !== 0) {
		console.error(`    Build failed: ${transformerVersionDirectory}`);
		console.error((result.stdout || result.stderr || result.error?.message || '').trim());
		return false;
	}

	return true;
}

function runTests(transformerVersionDirectory, tests, transformerLabel, root, html) {
	const actualDirectory = path.join(transformerVersionDirectory, 'test_results', 'actual');
	const expectedDirectory = path.join(transformerVersionDirectory, 'test_results', 'expected');
	fs.rmSync(actualDirectory, { recursive: true, force: true });
	fs.mkdirSync(actualDirectory, { recursive: true });

	// isolated per version, so coverage reports can be generated per package
	const versionCoverageDirectory = path.join(coverageRoot, sanitizeLabel(transformerLabel));
	fs.rmSync(versionCoverageDirectory, { recursive: true, force: true });
	fs.mkdirSync(versionCoverageDirectory, { recursive: true });
	let executionSucceeded = buildTransformer(transformerVersionDirectory);

	for (const test of tests) {
		if (!executionSucceeded) {
			break;
		}

		const testName = path.parse(test).name;
		const transformer = path.join(transformerVersionDirectory, 'dist', 'index.generated.js');
		const result = spawnSync(process.execPath, [transformer], {
			cwd: transformerVersionDirectory,
			encoding: 'utf8',
			input: fs.readFileSync(test, 'utf8'),
			env: { ...process.env, NODE_V8_COVERAGE: versionCoverageDirectory },
		});

		fs.writeFileSync(path.join(actualDirectory, testName), result.stdout ?? '');
		if (result.error || result.status !== 0) {
			executionSucceeded = false;
		}
	}

	const passed = executionSucceeded && resultDirectoriesMatch(actualDirectory, expectedDirectory);
	console.log(`    ${passed ? 'PASS' : 'FAIL'} ${transformerLabel}`);
	if (!passed) {
		failedTransformers.push({ transformerLabel, actualDirectory, expectedDirectory });
	}

	reportPackageCoverage(transformerVersionDirectory, versionCoverageDirectory, transformerLabel, root, html);
	return passed;
}

function reportPackageCoverage(transformerVersionDirectory, versionCoverageDirectory, transformerLabel, root, html) {
	if (filesIn(versionCoverageDirectory).length === 0) {
		return;
	}

	// cwd must contain the covered transformer files, since c8 filters files outside its cwd.
	const textResult = spawnSync(process.execPath, [
		c8Binary, 'report',
		'--temp-directory', versionCoverageDirectory,
		'--reporter=text',
		'--exclude', '**/*.generated/**',
		'--exclude', '**/*.generated.js',
	], { cwd: root, encoding: 'utf8' });

	if (textResult.status === 0) {
		console.log(textResult.stdout.trimEnd().split('\n').map((line) => `    ${line}`).join('\n'));
	}

	if (!html) {
		return;
	}

	const htmlReportDirectory = path.join(transformerVersionDirectory, 'coverage-html');
	const htmlResult = spawnSync(process.execPath, [
		c8Binary, 'report',
		'--temp-directory', versionCoverageDirectory,
		'--reporter=html',
		'--exclude', '**/*.generated/**',
		'--exclude', '**/*.generated.js',
		'--report-dir', htmlReportDirectory,
	], { cwd: root, stdio: 'inherit' });

	if (htmlResult.error || htmlResult.status !== 0) {
		console.error(`Failed to generate HTML coverage report for ${transformerLabel}.`);
		process.exitCode = 1;
		return;
	}

	const summaryDirectory = path.join(versionCoverageDirectory, '_summary');
	const summaryResult = spawnSync(process.execPath, [
		c8Binary, 'report',
		'--temp-directory', versionCoverageDirectory,
		'--reporter=json-summary',
		'--exclude', '**/*.generated/**',
		'--exclude', '**/*.generated.js',
		'--report-dir', summaryDirectory,
	], { cwd: root });

	if (summaryResult.error || summaryResult.status !== 0) {
		return;
	}

	const summary = JSON.parse(fs.readFileSync(path.join(summaryDirectory, 'coverage-summary.json'), 'utf8'));
	packageCoverageResults.push({
		transformerLabel,
		reportPath: path.join(htmlReportDirectory, 'index.html'),
		total: summary.total,
	});
}

function listProject(projectDirectory, root, html) {
	const projectName = path.relative(root, projectDirectory) || path.basename(projectDirectory);
	console.log(`${projectName}:`);

	for (const projectVersion of directoriesIn(path.join(projectDirectory, 'versions'))) {
		const versionDirectory = path.join(projectDirectory, 'versions', projectVersion);
		const testsDirectory = path.join(versionDirectory, 'tests');
		const tests = filesIn(testsDirectory);

		console.log(`  Tests (${projectVersion}):`);
		if (tests.length === 0) {
			console.log('    (none)');
		} else {
			for (const test of tests) {
				console.log(`    ${path.parse(test).name}`);
			}
		}

		console.log(`  Transformers (${projectVersion}):`);
		const transformersDirectory = path.join(versionDirectory, 'transformers');
		const transformerNames = directoriesIn(transformersDirectory);
		if (transformerNames.length === 0) {
			console.log('    (none)');
			continue;
		}

		for (const transformerName of transformerNames) {
			const transformerDirectory = path.join(transformersDirectory, transformerName);
			const transformerVersions = directoriesIn(path.join(transformerDirectory, 'versions'));
			if (transformerVersions.length === 0) {
				const relativePath = path.relative(transformersDirectory, transformerDirectory).split(path.sep).join('/');
				console.log(`    /${projectVersion}/${relativePath}`);
				continue;
			}

			for (const transformerVersion of transformerVersions) {
				const versionDirectory = path.join(transformerDirectory, 'versions', transformerVersion);
				const relativePath = path.relative(transformersDirectory, versionDirectory).split(path.sep).join('/');
				if (!runTests(versionDirectory, tests, `/${projectVersion}/${relativePath}`, root, html)) {
					process.exitCode = 1;
				}
			}
		}

		const serializerDirectory = path.join(versionDirectory, 'serialize');
		if (fs.existsSync(path.join(serializerDirectory, 'package.json'))) {
			const serializerTests = tests.filter((test) => test.endsWith('.slna'));
			console.log(`  Serializers (${projectVersion}):`);
			console.log(`    /${projectVersion}/serialize`);
			if (!runTests(serializerDirectory, serializerTests, `/${projectVersion}/serialize`, root, html)) {
				process.exitCode = 1;
			}
		}
	}
}

function openComparison(failure) {
	return new Promise((resolve) => {
		const comparison = spawn('bcompare', [failure.expectedDirectory, failure.actualDirectory], {
			detached: true,
			stdio: 'ignore',
		});

		comparison.once('error', (error) => {
			console.error(`Could not launch Beyond Compare for ${failure.transformerLabel}: ${error.message}`);
			process.exitCode = 1;
			resolve();
		});
		comparison.once('spawn', () => {
			comparison.unref();
			console.log(`Opened Beyond Compare for ${failure.transformerLabel}`);
			resolve();
		});
	});
}

async function askToLaunchComparisons() {
	if (failedTransformers.length === 0) {
		return;
	}

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.log('Beyond Compare prompt skipped because this run is non-interactive.');
		return;
	}

	const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
	let answer;
	try {
		answer = await prompt.question(`Launch Beyond Compare for ${failedTransformers.length} failed transformer version(s)? [y/N] `);
	} finally {
		prompt.close();
	}

	if (/^y(es)?$/i.test(answer.trim())) {
		await Promise.all(failedTransformers.map(openComparison));
	}
}

function buildSummaryHtml(root) {
	if (packageCoverageResults.length === 0) {
		return;
	}

	const rows = packageCoverageResults.map(({ transformerLabel, reportPath, total }) => {
		const relativeLink = path.relative(root, reportPath).split(path.sep).join('/');
		return `			<tr>
				<td><a href="${relativeLink}">${transformerLabel}</a></td>
				<td>${total.lines.pct}%</td>
				<td>${total.statements.pct}%</td>
				<td>${total.branches.pct}%</td>
				<td>${total.functions.pct}%</td>
			</tr>`;
	}).join('\n');

	const totalOf = (metric) => {
		const covered = packageCoverageResults.reduce((sum, { total }) => sum + total[metric].covered, 0);
		const all = packageCoverageResults.reduce((sum, { total }) => sum + total[metric].total, 0);
		return all === 0 ? 100 : Math.round((covered / all) * 10000) / 100;
	};

	const html = `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<title>Coverage summary</title>
	<style>
		body { font-family: sans-serif; margin: 2rem; }
		table { border-collapse: collapse; width: 100%; }
		th, td { border: 1px solid #ccc; padding: 0.4rem 0.8rem; text-align: left; }
		tfoot td { font-weight: bold; }
	</style>
</head>
<body>
	<h1>Coverage summary</h1>
	<table>
		<thead>
			<tr><th>Package</th><th>Lines</th><th>Statements</th><th>Branches</th><th>Functions</th></tr>
		</thead>
		<tbody>
${rows}
		</tbody>
		<tfoot>
			<tr><td>Total</td><td>${totalOf('lines')}%</td><td>${totalOf('statements')}%</td><td>${totalOf('branches')}%</td><td>${totalOf('functions')}%</td></tr>
		</tfoot>
	</table>
</body>
</html>
`;

	const summaryPath = path.join(root, 'coverage-summary.html');
	fs.writeFileSync(summaryPath, html);
	console.log(`\nCoverage summary: ${summaryPath}`);
}

async function main() {
	const args = process.argv.slice(2);
	const html = args.includes('--html');
	const inputPath = args.find((arg) => arg !== '--html');
	if (!inputPath) {
		console.error('Usage: node run_tests.js <transformer-projects-directory-or-project-directory> [--html]');
		process.exitCode = 1;
		return;
	}

	const root = path.resolve(inputPath);
	if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
		console.error(`Not a directory: ${inputPath}`);
		process.exitCode = 1;
		return;
	}

	fs.rmSync(coverageRoot, { recursive: true, force: true });
	fs.mkdirSync(coverageRoot, { recursive: true });

	for (const projectDirectory of projectDirectories(root)) {
		listProject(projectDirectory, root, html);
	}

	if (html) {
		buildSummaryHtml(root);
	}
	await askToLaunchComparisons();
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
