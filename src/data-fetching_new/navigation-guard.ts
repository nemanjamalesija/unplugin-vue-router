import type {
  Router,
  NavigationGuard,
  RouteLocationNormalizedLoaded,
} from 'vue-router'
import { isNavigationFailure } from 'vue-router'
import { effectScope, type App, type EffectScope } from 'vue'
import {
  ABORT_CONTROLLER_KEY,
  APP_KEY,
  LOADER_ENTRIES_KEY,
  LOADER_SET_KEY,
  PENDING_LOCATION_KEY,
} from './symbols'
import { IS_CLIENT, assign, isDataLoader, setCurrentContext } from './utils'
import type { _Awaitable } from '../core/utils'

/**
 * Setups the different Navigation Guards to collect the data loaders from the route records and then to execute them.
 *
 * @param router - the router instance
 * @returns
 */
export function setupLoaderGuard({ router, app }: SetupLoaderGuardOptions) {
  // avoid creating the guards multiple times
  if (router[LOADER_ENTRIES_KEY] != null) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[vue-router]: Data fetching was setup twice. Make sure to setup only once.'
      )
    }
    return () => {}
  }

  // Access to the entries map for convenience
  router[LOADER_ENTRIES_KEY] = new WeakMap()

  // Access to `app.runWithContext()`
  router[APP_KEY] = app

  // guard to add the loaders to the meta property
  const removeLoaderGuard = router.beforeEach((to) => {
    // Abort any pending navigation
    if (router[PENDING_LOCATION_KEY]) {
      // TODO: test
      // TODO: add a reason to abort()
      router[PENDING_LOCATION_KEY].meta[ABORT_CONTROLLER_KEY]!.abort()
    }

    // global pending location, used by nested loaders to know if they should load or not
    router[PENDING_LOCATION_KEY] = to
    // Differently from records, this one is reset on each navigation
    // so it must be built each time
    to.meta[LOADER_SET_KEY] = new Set()
    // reference the loader entries map for convenience
    // TODO: ensure we need this as we seem to have access to the router instance in all places
    to.meta[LOADER_ENTRIES_KEY] = router[LOADER_ENTRIES_KEY]
    // adds an abort controller that can pass a signal to loaders
    to.meta[ABORT_CONTROLLER_KEY] = new AbortController()

    // Collect all the lazy loaded components to await them in parallel
    const lazyLoadingPromises = []

    for (const record of to.matched) {
      // we only need to do this once per record as these changes are preserved
      // by the router
      if (!record.meta[LOADER_SET_KEY]) {
        // setup an empty array to skip the check next time
        record.meta[LOADER_SET_KEY] = new Set(record.meta.loaders || [])

        // add all the loaders from the components to the set
        for (const componentName in record.components) {
          const component: unknown = record.components[componentName]

          // we only add async modules because otherwise the component doesn't have any loaders and the user should add
          // them with the `loaders` array
          if (isAsyncModule(component)) {
            const promise = component().then(
              (viewModule: Record<string, unknown>) => {
                for (const exportName in viewModule) {
                  const exportValue = viewModule[exportName]

                  if (isDataLoader(exportValue)) {
                    record.meta[LOADER_SET_KEY]!.add(exportValue)
                  }
                }
              }
            )

            lazyLoadingPromises.push(promise)
          }
        }
      }
    }

    return Promise.all(lazyLoadingPromises).then(() => {
      // group all the loaders in a single set
      for (const record of to.matched) {
        // merge the whole set of loaders
        for (const loader of record.meta[LOADER_SET_KEY]!) {
          to.meta[LOADER_SET_KEY]!.add(loader)
        }
      }
      // we return nothing to remove the value to allow the navigation
      // same as return true
    })
  })

  const removeDataLoaderGuard = router.beforeResolve((to) => {
    // if we reach this guard, all properties have been set
    const loaders = Array.from(to.meta[LOADER_SET_KEY]!)
    /**
     * - ~~Map the loaders to an array of promises~~
     * - ~~Await all the promises (parallel)~~
     * - Collect NavigationResults and call `selectNavigationResult` to select the one to use
     */

    // TODO: could we benefit anywhere here from verifying the signal is aborted and not call the loaders at all
    // if (to.meta[ABORT_CONTROLLER_KEY]!.signal.aborted) {
    //   return
    // }

    // unset the context so all loaders are executed as root loaders
    setCurrentContext([])
    return Promise.all(
      loaders.map((loader) => {
        const { commit, server, lazy } = loader._.options
        // do not run on the server if specified
        if (!server && !IS_CLIENT) {
          return
        }
        // keep track of loaders that should be committed after all loaders are done
        const ret = app
          // allows inject and provide APIs
          .runWithContext(() => loader._.load(to, router))
          .then(() => {
            // for immediate loaders, the load function handles this
            // NOTE: it would be nice to also have here the immediate commit
            // but running it here is too late for nested loaders as we are appending
            // to the pending promise that is actually awaited in nested loaders
            if (commit === 'after-load') {
              return loader
            }
          })
        // on client-side, lazy loaders are not awaited, but on server they are
        return IS_CLIENT && lazy
          ? undefined
          : // return the non-lazy loader to commit changes after all loaders are done
            ret
      })
    ) // let the navigation go through by returning true or void
      .then((loaders) => {
        for (const loader of loaders) {
          if (loader) {
            // console.log(`⬇️ Committing ${loader.name}`)
            loader._.getEntry(router).commit(to)
          }
        }
        // TODO:
        // reset the initial state as it can only be used once
        // initialData = undefined
        // NOTE: could this be dev only?
        // isFetched = true
      })
    // no catch so errors are propagated to the router
    // TODO: handle navigation failures that could be returned by any loaders
  })

  // listen to duplicated navigation failures to reset the pendingTo and pendingLoad
  // since they won't trigger the beforeEach or beforeResolve defined above
  const removeAfterEach = router.afterEach((to, _from, failure) => {
    // abort the signal of a failed navigation
    // we need to check if it exists because the navigation guard that creates
    // the abort controller could not be triggered depending on the failure
    if (failure && to.meta[ABORT_CONTROLLER_KEY]) {
      to.meta[ABORT_CONTROLLER_KEY].abort(failure)
    }

    if (
      isNavigationFailure(failure, 16 /* NavigationFailureType.duplicated */)
    ) {
      if (router[PENDING_LOCATION_KEY]) {
        // the PENDING_LOCATION_KEY is set at the same time the LOADER_SET_KEY is set
        // so we know it exists
        router[PENDING_LOCATION_KEY].meta[LOADER_SET_KEY]!.forEach((loader) => {
          const entry = loader._.getEntry(router)
          entry.pendingTo = null
          entry.pendingLoad = null
        })
        // avoid this navigation being considered valid by the loaders
        router[PENDING_LOCATION_KEY] = null
      }
    }
  })

  // abort the signal on thrown errors
  const removeOnError = router.onError((error, to) => {
    // same as with afterEach, we check if it exists because the navigation guard
    // that creates the abort controller could not be triggered depending on the error
    if (to.meta[ABORT_CONTROLLER_KEY]) {
      to.meta[ABORT_CONTROLLER_KEY].abort(error)
    }
  })

  return () => {
    // @ts-expect-error: must be there in practice
    delete router[LOADER_ENTRIES_KEY]
    removeLoaderGuard()
    removeDataLoaderGuard()
    removeAfterEach()
    removeOnError()
  }
}

/**
 * Allows differentiating lazy components from functional components and vue-class-component
 * @internal
 *
 * @param component
 */
export function isAsyncModule(
  asyncMod: unknown
): asyncMod is () => Promise<Record<string, unknown>> {
  return (
    typeof asyncMod === 'function' &&
    // vue functional components
    !('displayName' in asyncMod) &&
    !('props' in asyncMod) &&
    !('emits' in asyncMod) &&
    !('__vccOpts' in asyncMod)
  )
}

/**
 * Options to initialize the data loader guard.
 */
export interface SetupLoaderGuardOptions {
  /**
   * The Vue app instance. Used to access the `provide` and `inject` APIs.
   */
  app: App<unknown>

  /**
   * The router instance. Adds the guards to it
   */
  router: Router

  /**
   * Initial data to skip the initial data loaders. This is useful for SSR and should be set only on client side.
   */
  initialData?: Record<string, unknown>

  /**
   * Hook that is called before each data loader is called. Can return a promise to delay the data loader call.
   */
  beforeLoad?: (route: RouteLocationNormalizedLoaded) => Promise<unknown>

  /**
   * Called if any data loader returns a `NavigationResult` with an array of them. Should decide what is the outcome of
   * the data fetching guard. Note this isn't called if no data loaders return a `NavigationResult`.
   */
  selectNavigationResult?: (
    results: NavigationResult[]
  ) => _Awaitable<NavigationResult | undefined | void>
}

/**
 * Possible values to change the result of a navigation within a loader
 * @internal
 */
export type _DataLoaderRedirectResult = Exclude<
  ReturnType<NavigationGuard>,
  // only preserve values that cancel the navigation
  Promise<unknown> | Function | true | void | undefined
>

/**
 * Possible values to change the result of a navigation within a loader.
 *
 * @example
 * ```ts
 * export const useUserData = defineLoader(async (to) => {
 *   const user = await fetchUser(to.params.id)
 *   if (!user) {
 *     return { redirect: '/404' }
 *   }
 *   return user
 * })
 * ```
 */
export class NavigationResult {
  constructor(public readonly value: _DataLoaderRedirectResult) {}
}

/**
 * Data Loader plugin to add data loading support to Vue Router.
 *
 * @example
 * ```ts
 * import { createApp } from 'vue'
 * import {
 *   createRouter,
 *   DataLoaderPlugin,
 *   createWebHistory,
 * } from 'vue-router/auto'
 *
 * const router = createRouter({
 *   history: createWebHistory(),
 * })
 *
 * const app = createApp({})
 * app.use(DataLoaderPlugin, { router })
 * app.use(router)
 * ```
 */
export function DataLoaderPlugin(app: App, options: DataLoaderPluginOptions) {
  const effect = effectScope(true)
  const removeGuards = setupLoaderGuard(assign({ app }, options))

  // TODO: use https://github.com/vuejs/core/pull/8801 if merged
  const { unmount } = app
  app.unmount = () => {
    effect.stop()
    removeGuards()
    unmount.call(app)
  }
}

/**
 * Options passed to the DataLoaderPlugin.
 */
export interface DataLoaderPluginOptions
  extends Omit<SetupLoaderGuardOptions, 'app'> {}
