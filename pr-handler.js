const shell = require( 'shelljs' );
const util = require( 'util' );
const fs = require( 'fs' );
const fetch = require( 'node-fetch' );
const { execSync, exec } = require( 'child_process' );
const execAsync = util.promisify( exec );

// Config constants.
const CHECK_RUN_NAME    = process.env.CHECK_RUN_NAME    || 'Elementor Tests';
const DB_NAME           = process.env.DB_NAME           || 'tests-db';
const DB_USER           = process.env.DB_USER           || 'root';
const DB_PASSWORD       = process.env.DB_PASSWORD       || 'root';
const DB_HOST           = process.env.DB_HOST           || 'localhost';
const SLACK_TOKEN 		= process.env.SLACK_TOKEN 		|| '';
const SLACK_CHANNEL 	= process.env.SLACK_CHANNEL 	|| '';

class PR_Handler
{
	/**
	 * Initialize the PR handler.
	 * 
	 * @param {Object} params.head      The PR HEAD commit.
	 * @param {Object} params.app       A Probot app instance.
	 * @param {Object} params.context   A webhook context.
	 */
	constructor( { head, app, context } )
	{
		this.head = head;
		this.app = app;
		this.context = context;

		// Extract props from HEAD.
		this.commitSHA  = head.sha;
		this.owner      = head.repo.owner.login;
		this.repo       = head.repo.name;
		this.ref        = head.ref;
		this.repoURL    = `https://github.com/${ this.owner }/${ this.repo }.git`;

		this.WORKING_DIR    = `/tmp/elementor-tests/${ new Date().getTime() }-${ this.commitSHA }`;
		this.ELEMENTOR_PATH = `${ this.WORKING_DIR }/elementor/elementor.php`;

		this.handle();
	}

	/**
	 * Handle an incoming PR.
	 * 
	 * @returns {void}
	 */
	async handle()
	{
		this.log( `New PR. Processing...` );
		
		// Create a check run.
		await this.githubCheckRun( { status: 'in_progress' } );
		
		// Cleanup.
		this.log( 'Cleaning working directories...' );
		shell.exec( `rm -rf ${ this.WORKING_DIR }` );
		shell.mkdir( '-p', this.WORKING_DIR );

		// Clone.
		try
		{
			this.log( 'Cloning repos...' );
			await this.cloneRepos();
		}

		catch
		{
			this.error( 'Cannot clone repos.' );
			return;
		}

		// Build.
		try
		{
			this.log( 'Building the projects files...' );
			await this.runBuild();
		}

		catch( e )
		{
			this.error( 'Cannot run build commands.' );
			return;
		}
		
		// Setup Pro tests.
		let phpunit, jest;

		try
		{
			this.log( 'Setting up tests...' );
			( { phpunit, jest } = this.executeTests() );
		}
		
		catch( e )
		{
			this.error( 'Failed executing tests.' );
		}

		// Determine if the tests were successful.
		const phpunitSuccess = ( phpunit.code === 0 );
		const jestSuccess = ( jest.code === 0 );
		const success = ( phpunitSuccess && jestSuccess );

		const phpunitSuccessMessage = phpunitSuccess ? 'Success' : 'Failed';
		const jestSuccessMessage = jestSuccess ? 'Success' : 'Failed';

		// Build check summary.
		let phpunitSummary = [], jestSummary = [];

		phpunitSummary.push( `*PR: ${ this.head.label }*` );
		phpunitSummary.push( `*PHPUnit: ${ phpunitSuccessMessage }*` );
		phpunitSummary.push( '```' + phpunit.stdout + phpunit.stderr + '```' );

		jestSummary.push( `*PR: ${ this.head.label }*` );
		jestSummary.push( `*Jest: ${ jestSuccessMessage }*` );
		jestSummary.push( '```' + jest.stdout + jest.stderr + '```' );

		// Send the messages to Slack.
		try
		{
			const summary = [];

			if ( ! phpunitSuccess )
			{
				const message = await this.slackMessage( phpunitSummary.join( '\n' ) );
				summary.push( `PHPUnit ( ${ phpunitSuccessMessage } ): ${ message }` );
			}

			if ( ! jestSuccess )
			{
				const message = await this.slackMessage( jestSummary.join( '\n' ) );
				summary.push( `Jest ( ${ jestSuccessMessage } ): ${ message }` );
			}
	
			// Set response data.
			const conclusion = success ? 'success' : 'failure';
			const title = success ? 'Successful' : 'Failed';

			// Send the check run result.
			await this.githubCheckRun( {
				conclusion,
				output: {
					title,
					summary: summary.join( '\n' ),
				},
			} );
		}

		catch( e )
		{
			this.error( 'Cannot send message to Slack.' );
		}

		this.cleanup();

		this.log( `Finished processing PR.` );
	}

	/**
	 * Output a log message to the console.
	 * 
	 * @param {String} message 
	 * 
	 * @returns {void}
	 */
	log( message )
	{
		this.app.log( `[ ${ this.head.label } ] :: ${ message }` );
	}

	/**
	 * Log an error to the console & cleanup.
	 * 
	 * @param {String} message 
	 */
	async error( message )
	{
		await this.githubCheckRun( {
			conclusion: 'failure',
			output: {
				title: 'CI Server Error',
				summary: message,
			},
		} );

		this.log( `ERROR: ${ message }` );
		this.cleanup();
	}

	/**
	 * Clean the current working directory.
	 * 
	 * @returns {void}
	 */
	cleanup()
	{
		shell.exec( `rm -rf ${ this.WORKING_DIR }` );
	}

	/**
	 * Create / Update a Github check run.
	 * 
	 * @param {Object} data The check run data to send.
	 * 
	 * @returns {Promise}
	 */
	async githubCheckRun( data )
	{
		try
		{
			// Extract the base repo owner.
			const owner = this.context.payload.repository.owner.login;

			return this.context.octokit.request( 'POST /repos/{owner}/{repo}/check-runs', {
				owner,
				repo: this.repo,
				name: CHECK_RUN_NAME,
				head_sha: this.commitSHA,
				...data
			} );
		}

		catch( e )
		{
			this.error( 'Cannot send Github check run data.' );
		}
	}

	/**
	 * Clone the Core & Pro repos asynchronously.
	 * 
	 * @returns {Promise}
	 */
	async cloneRepos()
	{
		shell.cd( this.WORKING_DIR );
		shell.exec( 'rm -rf elementor' );
		shell.exec( 'rm -rf elementor-pro' );

		const token = process.env.ACCESS_TOKEN;
		const core = execAsync( `git clone --single-branch --branch ${ this.ref } ${ this.repoURL } elementor` );
		const pro = execAsync( `git clone --single-branch --branch develop https://${ token }:x-oauth-basic@github.com/elementor/elementor-pro.git` );

		return Promise.all( [ core, pro ] );
	}

	/**
	 * Install & build the JS source.
	 * 
	 * @returns {Promise}
	 */
	async runBuild()
	{
		// Install Core.
		shell.cd( `${ this.WORKING_DIR }/elementor` );
		shell.exec( `git checkout ${ this.commitSHA }`, { silent: true } );
		const core = execAsync( 'npm i && npx grunt scripts' );
		
		// Install Pro.
		shell.cd( `${ this.WORKING_DIR }/elementor-pro` );
		const pro = execAsync( 'npm i && npx grunt scripts' );

		return Promise.all( [ core, pro ] );
	}

	/**
	 * Execute the Pro tests.
	 * 
	 * @returns {Object}
	 */
	executeTests()
	{
		shell.cd( `${ this.WORKING_DIR }/elementor-pro` );
		shell.exec( `bash ./bin/install-wp-tests.sh ${ DB_NAME } ${ DB_USER } ${ DB_PASSWORD } ${ DB_HOST } > /dev/null 2>&1` );
		execSync( `rm -rf /tmp/wordpress/wp-content/plugins/elementor/` );

		// Install PHPUnit if not exists.
		// TODO: Remove?
		if ( ! fs.existsSync( './vendor/bin/phpunit' ) )
		{
			shell.exec( `composer require "phpunit/phpunit:7.5.9" > /dev/null 2>&1` );
		}

		// Run tests.
		this.log( 'Executing PHPUnit...' );
		const phpunit = shell.exec( `export WP_TESTS_ELEMENTOR_DIR="${ this.ELEMENTOR_PATH }" && ./vendor/bin/phpunit -v` );

		this.log( 'Executing Jest...' );
		const jest = shell.exec( `npm run test:jest` );

		return {
			phpunit,
			jest,
		};
	}


	/**
	 * Send a message to Slack using the Slack API.
	 * 
	 * @param {String} text 		The text to send as a message.
	 * @param {Boolean} isMakrdown 	Determine if the message should be parsed as Markdown.
	 * 
	 * @returns {String} 			URL to the created message.
	 */
	async slackMessage( text, isMakrdown = true )
	{
		const endpoint = 'https://slack.com/api/chat.postMessage';

		const headers = {
			'Content-type': 'application/json',
			'Authorization': `Bearer ${ SLACK_TOKEN }`,
		};

		const data = {
			text,
			channel: SLACK_CHANNEL,
			mrkdwn: isMakrdown,
		};

		const res = await fetch( endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify( data ),
		} ).then( res => res.json() );

		if ( ! res.ok )
		{
			return null;
		}

		const { channel, ts } = res;

		return `https://elementor.slack.com/archives/${ channel }/p${ ts }`;
	}
}

module.exports = {
	PR_Handler,
};