import type { AppContext } from '@workspace/context/app-context'
import { optionsAccount } from '@workspace/db-react/options-account'
import { optionsNetwork } from '@workspace/db-react/options-network'
import { optionsSetting } from '@workspace/db-react/options-setting'
import { optionsWallet } from '@workspace/db-react/options-wallet'
import { queryClient } from '@workspace/db-react/query-client'
import { getEntrypoint } from '@workspace/env/get-entrypoint'
import { DemoTour } from '@workspace/feature-onboarding/demo/demo-tour'
import { UiErrorBoundary } from '@workspace/ui/components/ui-error-boundary'
import { UiLoaderFull } from '@workspace/ui/components/ui-loader-full'
import { UiNotFound } from '@workspace/ui/components/ui-not-found'
import { lazy } from 'react'
import { createHashRouter, Navigate, Outlet, type RouteObject } from 'react-router'
import { rootRouteLoader } from './data-access/root-route-loader.tsx'
import { ShellUiLayout } from './ui/shell-ui-layout.tsx'

const DevRoutes = lazy(() => import('@workspace/feature-dev/dev-routes'))
const ExplorerRoutes = lazy(() => import('@workspace/feature-explorer/explorer-routes'))
const FimsRoutes = lazy(() => import('@workspace/feature-fims/fims-routes'))
const OnboardingRoutes = lazy(() => import('@workspace/feature-onboarding/onboarding-routes'))
const PortfolioRoutes = lazy(() => import('@workspace/feature-portfolio/portfolio-routes'))
const FimsModals = lazy(() => import('@workspace/feature-fims/fims-modals'))
const ToolsRoutes = lazy(() => import('@workspace/feature-tools/tools-routes'))
const SettingsFeatureReset = lazy(() => import('@workspace/feature-settings/settings-feature-reset'))
const SettingsRoutes = lazy(() => import('@workspace/feature-settings/settings-routes'))
const RequestRoutes = lazy(() => import('@workspace/feature-request/request-routes'))

function getRoutes() {
  switch (getEntrypoint()) {
    case 'onboarding':
      return getOnboardingRoutes()
    case 'request':
      return getRequestRoutes()
    default:
      return getAppRoutes()
  }
}

export function createRouter(ctx: AppContext) {
  return createHashRouter([
    {
      children: getRoutes(),
      element: (
        <>
          <Outlet />
          <DemoTour />
        </>
      ),
      errorElement: <UiErrorBoundary />,
      hydrateFallbackElement: <UiLoaderFull />,
      id: 'root',
      loader: rootRouteLoader(ctx),
      shouldRevalidate: () =>
        [
          queryClient.getQueryState(optionsAccount.findMany(ctx, {}).queryKey)?.isInvalidated,
          queryClient.getQueryState(optionsNetwork.findMany(ctx, {}).queryKey)?.isInvalidated,
          queryClient.getQueryState(optionsSetting.findMany(ctx, {}).queryKey)?.isInvalidated,
          queryClient.getQueryState(optionsWallet.findMany(ctx, {}).queryKey)?.isInvalidated,
        ].some((isInvalidated) => isInvalidated || false),
    },
  ])
}

function getAppRoutes(): RouteObject[] {
  return [
    { element: <Navigate replace to="/portfolio" />, index: true },
    {
      children: [
        { element: <DevRoutes />, path: 'dev/*' },
        { element: <ExplorerRoutes basePath="/explorer" />, path: 'explorer/*' },
        { element: <FimsRoutes />, path: 'fims/*' },
        { element: <PortfolioRoutes />, path: 'portfolio/*' },
        { element: <SettingsRoutes />, path: 'settings/*' },
        { element: <ToolsRoutes />, path: 'tools/*' },
        { element: <UiNotFound />, path: '*' },
      ],
      element: <ShellUiLayout />,
    },
    { element: <FimsModals />, path: 'modals/*' },
    { element: <OnboardingRoutes redirectTo="/portfolio" />, path: 'onboarding/*' },
    { element: <SettingsFeatureReset />, path: 'reset' },
  ]
}

function getOnboardingRoutes(): RouteObject[] {
  return [
    { element: <Navigate replace to="/onboarding" />, index: true },
    { element: <OnboardingRoutes redirectTo="/onboarding/complete" />, path: 'onboarding/*' },
    { element: <UiNotFound />, path: '*' },
  ]
}

function getRequestRoutes(): RouteObject[] {
  return [
    { element: <Navigate replace to="/request" />, index: true },
    {
      element: <RequestRoutes />,
      id: 'request',
      loader: async () => {
        const { requestRouteLoader } = await import('@workspace/feature-request/data-access/request-route-loader')
        return await requestRouteLoader()
      },
      path: 'request/*',
    },
    { element: <UiNotFound />, path: '*' },
  ]
}
