const { PR_Handler: prHandler } = require( './pr-handler' );

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

		new prHandler( { head, app, context } );
		
	} );
}