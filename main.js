const { getReaderContract, getChainStorage, PreMinedTokenTotalSupply } = require('@mux-network/mux.js')
const ethers = require('ethers')
const BigNumber = require('bignumber.js')
const axios = require('axios')

const providerConfigs = [
  { url: 'https://arb1.arbitrum.io/rpc', chainId: 42161 },
  { url: 'https://api.avax.network/ext/bc/C/rpc', chainId: 43114 },
  { url: 'https://bsc-dataseed1.binance.org', chainId: 56 },
  { url: 'https://rpc.ftm.tools/', chainId: 250 },
  { url: 'https://mainnet.optimism.io', chainId: 10 }
]

async function main() {
  const assetPrices = await getAssetPrices() // you can replace the prices with your own price oracle
  const { aum, muxlpTotalSupply } = await getMultiChainLiquidity(assetPrices)
  console.log('AUM:', aum.toFixed())
  console.log('muxlpTotalSupply:', muxlpTotalSupply.toFixed())
  console.log('MUXLP Price:', aum.div(muxlpTotalSupply).toFixed())
}

// we need prices to calculate the AUM. in this demo we get prices from MUX API,
// which gives us assets prices and MUXLP price. we ignore the MUXLP price and
// demonstrate how to calculate it from other information. you can replace the
// asset prices with your own price oracle if you like.
async function getAssetPrices() {
  const rsp = await axios.get('https://app.mux.network/api/liquidityAsset', { timeout: 10 * 1000 })
  const prices = {}
  for (let asset of rsp.data.assets) {
    prices[asset.symbol] = new BigNumber(asset.price)
  }
  return prices
}

async function getMultiChainLiquidity(assetPrices) {
  const multiChainLiquidity = {}
  let muxlpTotalSupply = new BigNumber(PreMinedTokenTotalSupply)
  for (const providerConfig of providerConfigs) {
    const provider = new ethers.providers.StaticJsonRpcProvider(providerConfig.url, providerConfig.chainId)
    const singleChainLpDeduct = await getSingleChainLiquidity(provider, multiChainLiquidity)
    muxlpTotalSupply = muxlpTotalSupply.minus(singleChainLpDeduct)
  }

  let aum = new BigNumber(0)
  for (const symbol in multiChainLiquidity) {
    const liquidity = multiChainLiquidity[symbol]
    if (!liquidity.isStable) {
      liquidity.lpBalance = liquidity.lpBalance.minus(PreMinedTokenTotalSupply)
    }
    const price = assetPrices[symbol]
    if (!price) {
      throw new Error(`price not found for ${symbol}`)
    }
    const longUpnl = liquidity.totalLongPosition.times(price).minus(liquidity.longEntryValue)
    const shortUpnl = liquidity.shortEntryValue.minus(liquidity.totalShortPosition.times(price))
    aum = multiChainLiquidity[symbol].lpBalance.times(price).minus(longUpnl).minus(shortUpnl).plus(aum)
  }

  return {
    aum,
    muxlpTotalSupply,
  }
}

function getEmptyAsset() {
  return {
    isStable: false,
    lpBalance: new BigNumber(0),
    credit: new BigNumber(0),
    totalLongPosition: new BigNumber(0),
    totalShortPosition: new BigNumber(0),
    longEntryValue: new BigNumber(0),
    shortEntryValue: new BigNumber(0),
  }
}

async function getSingleChainLiquidity(provider, multiChainLiquidity) {
  const reader = await getReaderContract(provider)
  const state = await getChainStorage(reader)

  for (const asset of state.assets) {
    if (!asset.isEnabled) {
      continue
    }
    if (!(asset.symbol in multiChainLiquidity)) {
      multiChainLiquidity[asset.symbol] = getEmptyAsset()
    }
    const liquidity = multiChainLiquidity[asset.symbol]
    liquidity.isStable = asset.isStable
    liquidity.lpBalance = liquidity.lpBalance
      .plus(asset.spotLiquidity)
      .minus(asset.collectedFee)
    if (!asset.isStable) {
      liquidity.lpBalance = liquidity.lpBalance.plus(asset.deduct)
    }
    liquidity.credit = liquidity.credit.plus(asset.credit)
    liquidity.totalLongPosition = liquidity.totalLongPosition.plus(asset.totalLongPosition)
    liquidity.totalShortPosition = liquidity.totalShortPosition.plus(asset.totalShortPosition)
    liquidity.longEntryValue = asset.totalLongPosition.times(asset.averageLongPrice).plus(liquidity.longEntryValue)
    liquidity.shortEntryValue = asset.totalShortPosition.times(asset.averageShortPrice).plus(liquidity.shortEntryValue)
  }

  for (const dex of state.dexes) {
    dex.assetIds.forEach((assetId, i) => {
      const symbol = state.assets[assetId].symbol
      const liquidity = multiChainLiquidity[symbol]
      liquidity.lpBalance = liquidity.lpBalance.plus(dex.liquidityBalance[i])
    })
  }

  return state.lpDeduct
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error('error', error)
    process.exit(1)
  })
