const shell = require( 'shelljs' );
const util = require( 'util' );
const fs = require( 'fs' );
const { execSync, exec } = require( 'child_process' );
const execAsync = util.promisify( exec );

const CHECK_RUN_NAME = process.env.CHECK_RUN_NAME || 'Elementor Tests';
const DB_NAME = process.env.DB_NAME || 'tests-db';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || 'root';
const DB_HOST = process.env.DB_HOST || 'localhost';

module.exports = ( app ) => {
	
	// App initialized.
	app.log( 'Yay! The app was loaded!' );
	
	const events = [
		'pull_request.opened',
		'pull_request.reopened',
	];
	
	// Listen to PRs.
	app.on( events, async context => {
		
		// Get PR HEAD.
		const head = context.payload.pull_request.head;
		
		// Extract props from HEAD.
		const commitSHA = head.sha;
		const owner = head.repo.owner.login;
		const repo = head.repo.name;
		const ref = head.ref;
		const repoURL = `https://github.com/${ owner }/${ repo }.git`;
		const WORKING_DIR = `/tmp/${ commitSHA }`;
		const ELEMENTOR_PATH = `${ WORKING_DIR }/elementor/elementor.php`;

		app.log( `New PR (${ head.label }). Processing...` );
		
		// Create a check run.
		await githubCheckRun( context.octokit, {
			owner,
			repo,
			name: CHECK_RUN_NAME,
			head_sha: commitSHA,
			status: 'in_progress',
		} );
		
		// Cleanup.
		app.log( 'Cleaning working directories...' );
		shell.exec( `rm -rf ${ WORKING_DIR }` );
		shell.mkdir( WORKING_DIR );

		// Clone.
		app.log( 'Cloning repos...' );
		await cloneRepos( WORKING_DIR, { ref, repoURL } );

		// Build.
		app.log( 'Building the projects files...' );
		await runBuild( WORKING_DIR, commitSHA );
		
		// Setup Pro tests.
		app.log( 'Setting up tests...' );
		const { phpunit, qunit } = executeTests( WORKING_DIR, ELEMENTOR_PATH, app );

		// Determine if the tests were successful.
		const phpunitSuccess = ( phpunit.code === 0 );
		const qunitSuccess = ( qunit.code === 0 );
		const success = ( phpunitSuccess && qunitSuccess );
		
		// Set response data.
		const conclusion = success ? 'success' : 'failure';
		const title = success ? 'Successful' : 'Failed';

		// Build check summary.
		let summary = [];
		summary.push( `### PHPUnit: ${ phpunitSuccess ? 'Success' : 'Failed' }` );
		summary.push( '```' + phpunit.stdout + '```' );
		summary.push( `### QUnit: ${ qunitSuccess ? 'Success' : 'Failed' }` );
		summary.push( '```' + qunit.stdout + '```' );

		// Send the check run result.
		await githubCheckRun( context.octokit, {
			owner,
			repo,
			name: CHECK_RUN_NAME,
			head_sha: commitSHA,
			conclusion,
			output: {
				title,
				summary: summary.join( '\n' ),
			},
		} );

		shell.exec( `rm -rf ${ WORKING_DIR }` );

		app.log( `Finished processing PR (${ head.label }).` );
	} );
}

/**
 * Create / Update a Github check run.
 * 
 * @param {Object} octokit 	An octokit instacne.
 * @param {Object} data 		The check run data.
 * 
 * @returns {Promise}
 */
async function githubCheckRun( octokit, data )
{
	return octokit.request( 'POST /repos/{owner}/{repo}/check-runs', data );
}

/**
 * Clone the Core & Pro repos asynchronously.
 * 
 * @param {String} workingDir The current working directory to cd into.
 * @param {Object} { ref: string, repoURL: string } The Core repo ref branch and the full repo URL to clone from.
 * 
 * @returns {Promise}
 */
async function cloneRepos( workingDir, { ref, repoURL } )
{
	shell.cd( workingDir );
	shell.exec( 'rm -rf elementor' );
	shell.exec( 'rm -rf elementor-pro' );

	const token = process.env.ACCESS_TOKEN;
	const core = execAsync( `git clone --single-branch --branch ${ ref } ${ repoURL } elementor` );
	const pro = execAsync( `git clone --single-branch --branch master https://${ token }:x-oauth-basic@github.com/elementor/elementor-pro.git` );

	return Promise.all( [ core, pro ] );
}

/**
 * Install & build the JS source.
 * 
 * @param {String} workingDir 	The working directory where the clones are.
 * @param {String} commitSHA	The HEAD commit SHA of the current PR in the Core.
 * 
 * @returns {Promise}
 */
async function runBuild( workingDir, commitSHA )
{
	shell.cd( `${ workingDir }/elementor` );
	shell.exec( `git checkout ${ commitSHA }`, { silent: true } );
	const core = execAsync( `npm i && grunt` );
	
	shell.cd( `${ workingDir }/elementor-pro` );
	const pro = execAsync( `npm i && grunt` );

	return Promise.all( [ core, pro ] );
}

/**
 * Execute the Pro tests.
 * 
 * @param {String} workingDir 	The current working directory where the clones are located.
 * @param {String} corePath 	The path to the Core `elementor.php`.
 * @param {Probot} app 			The Probot app instance.
 * 
 * @returns {Object}
 */
function executeTests( workingDir, corePath, app )
{
	shell.cd( `${ workingDir }/elementor-pro` );
	shell.exec( `bash ./bin/install-wp-tests.sh ${ DB_NAME } ${ DB_USER } ${ DB_PASSWORD } ${ DB_HOST } > /dev/null 2>&1` );
	execSync( `rm -rf /tmp/wordpress/wp-content/plugins/elementor/` );

	// Install PHPUnit if not exists.
	// TODO: Remove?
	if ( ! fs.existsSync( './vendor/bin/phpunit' ) )
	{
		execSync( `composer require "phpunit/phpunit:7.5.9" > /dev/null 2>&1` );
	}

	// Run tests.
	app.log( 'Executing PHPUnit...' );
	const phpunit = shell.exec( `export WP_TESTS_ELEMENTOR_DIR=${ corePath } && ./vendor/bin/phpunit -v` );

	app.log( 'Executing Qunit...' );
	const qunit = shell.exec( `grunt karma:unit` );

	return {
		phpunit,
		qunit,
	};
}