const moment 	= require("moment")
const Stripe 	= require("stripe")
const express 	= require("express")
const router 	= express.Router()
const ejs 		= require("ejs")
let stripe = null
let options = {}

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

router.post('/webhook', asyncHandler(async (req, res, next) => {

	if (!stripe) stripe = Stripe(options.secretKey)

	// Make sure event is signed
	// let sig = req.header("stripe-signature")

	// Will fail if event doesn't exist
	let event = await stripe.events.retrieve(req.body.id)

	let type = event.type
	console.log('Stripe said: '+type)

	if (type === 'customer.subscription.trial_will_end') {
		
		// Send email for ending trial
		// sendMail(`Your trial is ending - ${options.siteName}`, `Hello,\n\nThis is an email to let you know that your ${options.siteName} trial will be ending soon.\n\nIf you do not wish to continue, you can cancel your subscription now in your dashboard. Else, you don't have anything to do :)\n\nCheers`, dbUser.email)

	} else if (type === 'customer.source.expiring') {

		// Send email for credit card expiring
		// Already handled by Stripe

	} else if (type === 'invoice.payment_failed') {
		
		// Send email for failed invoice payment
		// Already handled by Stripe
	
	} else if (type === 'customer.subscription.updated') {
		
		// Check status

	
	} else if (type === 'customer.subscription.deleted') {

		let customerId = event.data.object.customer
		let subscriptionId = event.data.object.id

		let user = await options.mongoUser.findOne({'stripe.customerId': customerId}).exec()
		
		if (user.plan) user.plan = 'free'
		user.stripe.subscriptionId = null
		user.stripe.subscriptionItems = []
		user.stripe.canceled = false
		user.save()

		if (options.onCancel && typeof options.onCancel === 'function') options.onCancel(user)


		sendMail(`Subscription canceled - ${options.siteName}`, 
`Hello,\n
This is an automatic email to inform that your ${options.siteName} subscription was canceled.
${options.cancelMailExtra ? options.cancelMailExtra + '\n' : ''}
We hope to see you back soon!`, user.email)

	} else {
		// Won't act on it
	}

	res.send({ received: true })
}))

const billing = async (customerId, user) => {
	
	if (!stripe) stripe = Stripe(options.secretKey)

	if (!customerId) {
		return {
			sources: [],
			invoices: [],
			upgradablePlans: options.plans,
			subscriptions: [],
			user: user,
			options: options
		}
	}

	let stripeCustomer = await stripe.customers.retrieve(customerId)

	const paymentMethods = await stripe.paymentMethods.list({ customer: customerId, type: 'card' })

	let sources = paymentMethods.data
	let subscriptions = stripeCustomer.subscriptions.data

	let defaultCard = sources.find(s => s.id = stripeCustomer.default_source)
	if (defaultCard) defaultCard.isDefault = true

	subscriptions = subscriptions.map(sub => {

		sub.currentPeriodStart = moment(sub.current_period_start * 1000).format("ll")
		sub.currentPeriodEnd = moment(sub.current_period_end * 1000).format("ll")
		
		if (sub.plan) { 
			sub.plan.amount = (sub.plan.amount / 100).toLocaleString('en-US', { 
				style: 'currency', 
				currency: 'USD'
			})
		}

		if (sub.discount && sub.discount.coupon) {
			let coupon = sub.discount.coupon

			sub.discountDescription = `${coupon.name}: -${coupon.percent_off ? coupon.percent_off + '%' : coupon.amount_off + ' ' + coupon.currency} for ${coupon.duration_in_months} months`
		}

		return sub
	})

	let allInvoices = await stripe.invoices.list({
		customer: customerId,
		limit: 5 
	})

	if (options.showDraftInvoice) {
		try {
			let upcomingInvoice = await stripe.invoices.retrieveUpcoming(customerId)
			allInvoices.data.unshift(upcomingInvoice)
		} catch(e) {
			// No upcoming invoices
		}
	}

	allInvoices = allInvoices.data
	.filter(invoice => invoice.amount_due > 0) // Only show 'real' invoices 
	.map(invoice => {
		invoice.amount = (invoice.amount_due / 100).toLocaleString('en-US', { 
			style: 'currency', 
			currency: 'USD'
		})

		// Because the invoice's own period isn't correct for the first invoice, we use the one from the first item
		invoice.cleanPeriodEnd = moment(invoice.lines.data[0].period.end * 1000).format('ll')
		invoice.cleanPeriodStart = moment(invoice.lines.data[0].period.start * 1000).format('ll')

		invoice.date = moment(invoice.date * 1000).format('ll')
		invoice.unpaid = (invoice.attempt_count > 1 && !invoice.paid)

		return invoice
	})

	let upgradablePlans = (options.plans || []).filter(p => user.plan !== p.id && p.id !== 'free')

	return {
		sources: sources,
		upgradablePlans: upgradablePlans,
		invoices: allInvoices,
		subscriptions: subscriptions,
		user: user,
		options: options
	}

}

router.use((req, res, next) => {
	if (!req.user) return next('Login required for billing.')

	res.locals.customerId = req.user.stripeCustomerId || (req.user.stripe ? req.user.stripe.customerId : null)
	res.locals.subscriptionId = req.user.subscription || (req.user.stripe ? req.user.stripe.subscriptionId : null)
	next()
})

router.get('/', asyncHandler(async (req, res, next) => {

	const customerId = res.locals.customerId
	const data = await billing(customerId, req.user)

	res.render(__dirname+'/billing.ejs', data)
}))

router.get('/testcoupon', (req, res, next) => {

	let coupons = options.coupons
	let couponToTest = req.query.code

	let exist = coupons && coupons.find(c => c.code === couponToTest)

	if (!exist) return res.send({ valid: false })

	res.send({
		valid: true,
		description: exist.description
	})
})


const addCardToCustomer = async (user, customerId, paymentMethodId) => {
	
	let stripe = Stripe(options.secretKey)
	let customer = null

	if (customerId) {

		await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId })

	} else {

		customer = await stripe.customers.create({ email: user.email, payment_method: paymentMethodId })

		let dbUser = await options.mongoUser.findById(user.id).exec()
		
		dbUser.stripe.customerId = customer.id
		
		await dbUser.save()
	}

	return customer
}

router.get('/setupintent', asyncHandler(async (req, res, next) => {

	let customerId = res.locals.customerId

	// Triggers authentication if needed
	const setupIntent = await stripe.setupIntents.create({ usage: 'off_session' })


	res.send({ clientSecret: setupIntent.client_secret })
}))


router.post('/upgrade', asyncHandler(async (req, res, next) => {

	let token = req.body.token
	let customerId = res.locals.customerId

	if (!customerId && !token) return next("Sorry! We need a credit card to subscribe you.")

	// If the customer doesn't have card or isn't a Stripe customer
	if (paymentMethodId) { 
		try {
			var customer = await addCardToCustomer(req.user, customerId, paymentMethodId)
		} catch(e) {
			return next("Sorry, we couldn't process your credit card. Please check with your bank.")
		}

		customerId = customer.id
	}

	let user = await options.mongoUser.findById(req.user.id).exec()

	let planId = req.body.upgradePlan

	let plan = options.plans.find(plan => plan.id === planId)
	if (!plan) return next('Invalid plan.')

	// If we supplied a coupon
	let couponCode = req.body.coupon
	let coupon = null
	if (options.coupons && options.coupons.find(c => c.code === couponCode)) {
		coupon = couponCode
	}

	let stripe = Stripe(options.secretKey)

	let subscriptionId = res.locals.subscriptionId

	if (subscriptionId) {

		var subscription = await stripe.subscriptions.retrieve(subscriptionId)

		await stripe.subscriptions.update(subscriptionId, {
			coupon: coupon || undefined,
			items: [{
				id: subscription.items.data[0].id,
				plan: plan.stripeId,
			}],
			expand: ['latest_invoice.payment_intent'],
		})

	} else {

		var subscription = await stripe.subscriptions.create({
								coupon: coupon || undefined,
								customer: customerId,
								trial_from_plan: true,
								payment_behavior: 'allow_incomplete',
								items: [{ plan: plan.stripeId }],
								expand: ['latest_invoice.payment_intent'],
							})
	}


	if (subscription.status === 'incomplete') {
		// Requires SCA auth

		// Depending if on-session or off-session, either waiting for card confirmation or payment confirmation
		if (subscription.pending_setup_intent) {

			var intent = subscription.pending_setup_intent
			var action = 'handleCardSetup'
		
		} else if (subscription.latest_invoice.payment_intent) {
		
			var intent = latest_invoice.payment_intent
			var action = 'handleCardPayment'
		
		} else {
		
			return next("We couldn't complete the transaction.")
		
		}

		if (paymentIntent.status === 'requires_action') {
			
			let secret = paymentIntent.client_secret
			res.send({ actionRequired: action, secret: intent.secret })
		
		} else if (intent.status === 'requires_payment_method') {
			
			return next('Please try with another card.')

		}

	}

	res.send({  })

	// Following needs to be put in webhook
	user.plan = plan.id
	user.stripe.subscriptionId = subscription.id

	await user.save()

	if (options.onUpgrade && typeof options.onUpgrade === 'function') options.onUpgrade(user, plan.id)

	sendMail("Thank you for upgrading", 
`Hello,\n
This is a confirmation email that you have successfully upgraded your account to the ${plan.name} plan.\n
If you have any question or suggestion, simply reply to this email.\n
Glad to have you on board :)`, user.email)

	

}))


router.post('/card', asyncHandler(async (req, res, next) => {

	let paymentMethodId = req.body.paymentMethodId
	let customerId = res.locals.customerId

	try {
		await addCardToCustomer(req.user, customerId, paymentMethodId)
	} catch(e) {
		return next(e)
	}

	res.send({})
}))

router.get('/chooseplan', asyncHandler(async (req, res, next) => {

	let customerId = res.locals.customerId

	let data = await billing(customerId, req.user)

	data.redirect = options.choosePlanRedirect

	res.render(__dirname+'/chooseplan', data)
}))


router.get('/cancelsubscription', asyncHandler(async (req, res, next) => {

	let user = await options.mongoUser.findById(req.user.id).exec()

	let subscriptionId = res.locals.subscriptionId

	await stripe.subscriptions.update(subscriptionId, {
 		cancel_at_period_end: true
 	})

 	user.stripe.canceled = true
	user.save()

	res.redirect('/account#billing')
}))

router.get('/resumesubscription', asyncHandler(async (req, res, next) => {

	let subscriptionId = res.locals.subscriptionId

	let user = await options.mongoUser.findById(req.user.id).exec()

	await stripe.subscriptions.update(subscriptionId, {
 		cancel_at_period_end: false
 	})

	user.stripe.canceled = false
	user.save()

	res.redirect('/account#billing')
}))

router.get('/billing.js', (req, res, next) => {
	res.sendFile(__dirname+'/billing.js')
})

module.exports = (opts) => {
	if (opts) options = opts

	sendMail = options.sendMail || function () {}

	return router
}