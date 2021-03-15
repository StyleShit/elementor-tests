const shell = require( 'shelljs' );
const util = require( 'util' );
const fs = require( 'fs' );
const { execSync, exec } = require( 'child_process' );
const execAsync = util.promisify( exec );

// Config constants.
const CHECK_RUN_NAME    = process.env.CHECK_RUN_NAME    || 'Elementor Tests';
const DB_NAME           = process.env.DB_NAME           || 'tests-db';
const DB_USER           = process.env.DB_USER           || 'root';
const DB_PASSWORD       = process.env.DB_PASSWORD       || 'root';
const DB_HOST           = process.env.DB_HOST           || 'localhost';

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
			this.log( 'ERROR: Cannot clone repos.' );
			return;
		}

		// Build.
        try
		{
            this.log( 'Building the projects files...' );
			await this.runBuild();
		}

		catch
		{
			this.log( 'ERROR: Cannot run build commands.' );
			return;
		}
		
		// Setup Pro tests.
        this.log( 'Setting up tests...' );
        const { phpunit, qunit } = this.executeTests();
        

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
		await this.githubCheckRun( {
			conclusion,
			output: {
				title,
				summary: summary.join( '\n' ),
			},
		} );

		shell.exec( `rm -rf ${ WORKING_DIR }` );

		this.log( `Finished processing PR.` );
    }

    /**
     * Output a log message to the console.
     * 
     * @param {string} message 
     */
    log( message )
    {
        this.app.log( `[ ${ this.head.label } ] :: ${ message }` );
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

        return this.context.octokit.request( 'POST /repos/{owner}/{repo}/check-runs', {
			owner: this.owner,
			repo: this.repo,
			name: CHECK_RUN_NAME,
			head_sha: this.commitSHA,
            ...data
		} );
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
        const pro = execAsync( `git clone --single-branch --branch master https://${ token }:x-oauth-basic@github.com/elementor/elementor-pro.git` );

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
        execSync( 'npm i' );
        const core = execAsync( `grunt` );
        
        // Install Pro.
        shell.cd( `${ this.WORKING_DIR }/elementor-pro` );
        execSync( `npm i` );
        const pro = execAsync( `grunt` );

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
            execSync( `composer require "phpunit/phpunit:7.5.9" > /dev/null 2>&1` );
        }

        // Run tests.
        this.log( 'Executing PHPUnit...' );
        const phpunit = shell.exec( `export WP_TESTS_ELEMENTOR_DIR=${ this.ELEMENTOR_PATH } && ./vendor/bin/phpunit -v` );

        this.log( 'Executing Qunit...' );
        const qunit = shell.exec( `grunt karma:unit` );

        return {
            phpunit,
            qunit,
        };
    }
}

module.exports = {
    PR_Handler,
};