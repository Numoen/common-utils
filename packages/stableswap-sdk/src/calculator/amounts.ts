import type { Token } from "@dahlia-labs/token-utils";
import {
  Fraction,
  ONE,
  TEN,
  TokenAmount,
  ZERO,
} from "@dahlia-labs/token-utils";
import JSBI from "jsbi";
import mapValues from "lodash.mapvalues";

import type { Fees, IExchangeInfo } from "../entities";
import { computeD, computeY } from "./curve";

export const normalizeAmount = (tokenAmount: TokenAmount): JSBI =>
  JSBI.multiply(
    tokenAmount.raw,
    JSBI.exponentiate(TEN, JSBI.BigInt(18 - tokenAmount.token.decimals))
  );

export const denormalizeAmount = (tokenAmount: TokenAmount): TokenAmount =>
  new TokenAmount(
    tokenAmount.token,
    JSBI.divide(
      tokenAmount.raw,
      JSBI.exponentiate(TEN, JSBI.BigInt(18 - tokenAmount.token.decimals))
    )
  );

/**
 * Calculates the current virtual price of the exchange.
 * @param exchange
 * @returns
 */
export const calculateVirtualPrice = (
  exchange: IExchangeInfo
): Fraction | null => {
  const amount = exchange.lpTotalSupply;
  if (amount === undefined || amount.equalTo(0)) {
    // pool has no tokens
    return null;
  }
  const price = new Fraction(
    computeD(
      exchange.ampFactor,
      normalizeAmount(exchange.reserves[0]),
      normalizeAmount(exchange.reserves[1])
    ),
    amount.raw
  );
  return price;
};

/**
 * Calculates the estimated output amount of a swap.
 * @param exchange
 * @param fromAmount
 * @returns
 */
export const calculateEstimatedSwapOutputAmount = (
  exchange: IExchangeInfo,
  fromAmount: TokenAmount
): {
  [K in
    | "outputAmountBeforeFees"
    | "outputAmount"
    | "fee"
    | "lpFee"
    | "adminFee"]: TokenAmount;
} => {
  const [fromReserves, toReserves] = fromAmount.token.equals(
    exchange.reserves[0].token
  )
    ? [exchange.reserves[0], exchange.reserves[1]]
    : [exchange.reserves[1], exchange.reserves[0]];

  if (fromAmount.equalTo(0)) {
    const zero = new TokenAmount(toReserves.token, ZERO);
    return {
      outputAmountBeforeFees: zero,
      outputAmount: zero,
      fee: zero,
      lpFee: zero,
      adminFee: zero,
    };
  }

  const amp = exchange.ampFactor;

  const amountBeforeFees = JSBI.subtract(
    normalizeAmount(toReserves),
    computeY(
      amp,
      JSBI.add(normalizeAmount(fromReserves), normalizeAmount(fromAmount)),
      computeD(amp, normalizeAmount(fromReserves), normalizeAmount(toReserves))
    )
  );

  const outputAmountBeforeFees = new TokenAmount(
    toReserves.token,
    amountBeforeFees
  );

  const fee = new TokenAmount(
    toReserves.token,
    exchange.fees.trade.asFraction.multiply(amountBeforeFees).quotient
  );

  const adminFee = new TokenAmount(
    toReserves.token,
    exchange.fees.admin.asFraction.multiply(fee.raw).quotient
  );
  const lpFee = fee.subtract(adminFee);

  const outputAmount = new TokenAmount(
    toReserves.token,
    JSBI.subtract(amountBeforeFees, fee.raw)
  );

  return {
    outputAmountBeforeFees: denormalizeAmount(outputAmountBeforeFees),
    outputAmount: denormalizeAmount(outputAmount),
    fee: denormalizeAmount(fee),
    lpFee: denormalizeAmount(lpFee),
    adminFee: denormalizeAmount(adminFee),
  };
};

const N_COINS = JSBI.BigInt(2);

export interface IWithdrawOneResult {
  withdrawAmount: TokenAmount;
  withdrawAmountBeforeFees: TokenAmount;
  swapFee: TokenAmount;
  withdrawFee: TokenAmount;
  lpSwapFee: TokenAmount;
  adminSwapFee: TokenAmount;
}

/**
 * Calculates the amount of tokens withdrawn if only withdrawing one token.
 * @returns
 */
export const calculateEstimatedWithdrawOneAmount = ({
  exchange,
  poolTokenAmount,
  withdrawToken,
}: {
  exchange: IExchangeInfo;
  poolTokenAmount: TokenAmount;
  withdrawToken: Token;
}): IWithdrawOneResult => {
  if (poolTokenAmount.equalTo(0)) {
    // final quantities
    const quantities = {
      withdrawAmount: ZERO,
      withdrawAmountBeforeFees: ZERO,
      swapFee: ZERO,
      withdrawFee: ZERO,
      lpSwapFee: ZERO,
      adminSwapFee: ZERO,
    };
    return mapValues(quantities, (q) => new TokenAmount(withdrawToken, q));
  }

  const { ampFactor, fees } = exchange;

  const withdrawReserves = exchange.reserves.find((r) =>
    r.token.equals(withdrawToken)
  );
  const nonWithdrawReserves = exchange.reserves.find(
    (r) => !r.token.equals(withdrawToken)
  );
  const baseReserves = withdrawReserves
    ? normalizeAmount(withdrawReserves)
    : ZERO;
  const quoteReserves = nonWithdrawReserves
    ? normalizeAmount(nonWithdrawReserves)
    : ZERO;

  const d_0 = computeD(ampFactor, baseReserves, quoteReserves);
  const d_1 = JSBI.subtract(
    d_0,
    JSBI.divide(
      JSBI.multiply(poolTokenAmount.raw, d_0),
      exchange.lpTotalSupply.raw
    )
  );

  const new_y = computeY(ampFactor, quoteReserves, d_1);

  // expected_base_amount = swap_base_amount * d_1 / d_0 - new_y;
  const expected_base_amount = JSBI.subtract(
    JSBI.divide(JSBI.multiply(baseReserves, d_1), d_0),
    new_y
  );
  // expected_quote_amount = swap_quote_amount - swap_quote_amount * d_1 / d_0;
  const expected_quote_amount = JSBI.subtract(
    quoteReserves,
    JSBI.divide(JSBI.multiply(quoteReserves, d_1), d_0)
  );
  // new_base_amount = swap_base_amount - expected_base_amount * fee / fee_denominator;
  const new_base_amount = new Fraction(baseReserves.toString(), 1).subtract(
    normalizedTradeFee(fees, N_COINS, expected_base_amount)
  );
  // new_quote_amount = swap_quote_amount - expected_quote_amount * fee / fee_denominator;
  const new_quote_amount = new Fraction(quoteReserves.toString(), 1).subtract(
    normalizedTradeFee(fees, N_COINS, expected_quote_amount)
  );
  const dy = new_base_amount.subtract(
    computeY(
      ampFactor,
      JSBI.BigInt(new_quote_amount.toFixed(0)),
      d_1
    ).toString()
  );
  const dy_0 = JSBI.subtract(baseReserves, new_y);

  // lp fees
  const swapFee = new Fraction(dy_0.toString(), 1).subtract(dy);
  const withdrawFee = dy.multiply(fees.withdraw.asFraction);

  // admin fees
  const adminSwapFee = swapFee.multiply(fees.admin.asFraction);

  // final LP fees
  const lpSwapFee = swapFee.subtract(adminSwapFee);

  // final withdraw amount
  const withdrawAmount = dy.subtract(withdrawFee).subtract(swapFee);

  // final quantities
  const quantities = {
    withdrawAmount,
    withdrawAmountBeforeFees: dy,
    swapFee,
    withdrawFee,
    lpSwapFee,
    adminSwapFee,
  };

  return mapValues(
    quantities,
    (q) => new TokenAmount(withdrawToken, q.toFixed(0))
  );
};

/**
 * Compute normalized fee for symmetric/asymmetric deposits/withdraws
 */
export const normalizedTradeFee = (
  { trade }: Fees,
  n_coins: JSBI,
  amount: JSBI
): Fraction => {
  const adjustedTradeFee = new Fraction(
    n_coins,
    JSBI.multiply(JSBI.subtract(n_coins, ONE), JSBI.BigInt(4))
  );
  return new Fraction(amount, 1).multiply(trade).multiply(adjustedTradeFee);
};

export const calculateEstimatedWithdrawAmount = ({
  poolTokenAmount,
  reserves,
  fees,
  lpTotalSupply,
}: {
  /**
   * Amount of pool tokens to withdraw
   */
  poolTokenAmount: TokenAmount;
} & Pick<IExchangeInfo, "reserves" | "lpTotalSupply" | "fees">): {
  withdrawAmounts: readonly [TokenAmount, TokenAmount];
  withdrawAmountsBeforeFees: readonly [TokenAmount, TokenAmount];
  fees: readonly [TokenAmount, TokenAmount];
} => {
  if (lpTotalSupply.equalTo(0)) {
    const zero = reserves.map((r) => new TokenAmount(r.token, ZERO)) as [
      TokenAmount,
      TokenAmount
    ];
    return {
      withdrawAmounts: zero,
      withdrawAmountsBeforeFees: zero,
      fees: zero,
    };
  }

  const share = poolTokenAmount.divide(lpTotalSupply);

  const withdrawAmounts = reserves.map((amount) => {
    const baseAmount = share.multiply(normalizeAmount(amount));
    const fee = baseAmount.multiply(fees.withdraw.asFraction);
    return [
      new TokenAmount(
        amount.token,
        JSBI.BigInt(baseAmount.subtract(fee).toFixed(0))
      ),
      {
        beforeFees: JSBI.BigInt(baseAmount.toFixed(0)),
        fee: JSBI.BigInt(fee.toFixed(0)),
      },
    ];
  }) as [
    [TokenAmount, { beforeFees: JSBI; fee: JSBI }],
    [TokenAmount, { beforeFees: JSBI; fee: JSBI }]
  ];

  return {
    withdrawAmountsBeforeFees: withdrawAmounts.map(([amt, { beforeFees }]) =>
      denormalizeAmount(new TokenAmount(amt.token, beforeFees))
    ) as [TokenAmount, TokenAmount],
    withdrawAmounts: [
      denormalizeAmount(withdrawAmounts[0][0]),
      denormalizeAmount(withdrawAmounts[1][0]),
    ],
    fees: withdrawAmounts.map(([amt, { fee }]) =>
      denormalizeAmount(new TokenAmount(amt.token, fee))
    ) as [TokenAmount, TokenAmount],
  };
};

/**
 * Calculate the estimated amount of LP tokens minted after a deposit.
 * @param exchange
 * @param depositAmountA
 * @param depositAmountB
 * @returns
 */
export const calculateEstimatedMintAmount = (
  exchange: IExchangeInfo,
  depositAmountA: JSBI,
  depositAmountB: JSBI
): {
  mintAmountBeforeFees: TokenAmount;
  mintAmount: TokenAmount;
  fees: TokenAmount;
} => {
  const normalizedDepositAmountA = normalizeAmount(
    new TokenAmount(exchange.reserves[0].token, depositAmountA)
  );
  const normalizedDepositAmountB = normalizeAmount(
    new TokenAmount(exchange.reserves[1].token, depositAmountB)
  );

  if (JSBI.equal(depositAmountA, ZERO) && JSBI.equal(depositAmountB, ZERO)) {
    const zero = new TokenAmount(exchange.lpTotalSupply.token, ZERO);
    return {
      mintAmountBeforeFees: zero,
      mintAmount: zero,
      fees: zero,
    };
  }

  const amp = exchange.ampFactor;
  const [reserveA, reserveB] = exchange.reserves;
  const d0 = computeD(
    amp,
    normalizeAmount(reserveA),
    normalizeAmount(reserveB)
  );

  const d1 = computeD(
    amp,
    JSBI.add(normalizeAmount(reserveA), normalizedDepositAmountA),
    JSBI.add(normalizeAmount(reserveB), normalizedDepositAmountB)
  );
  if (JSBI.lessThan(d1, d0)) {
    throw new Error("New D cannot be less than previous D");
  }

  const oldBalances = exchange.reserves.map((r) => normalizeAmount(r)) as [
    JSBI,
    JSBI
  ];
  const newBalances = [
    JSBI.add(normalizeAmount(reserveA), normalizedDepositAmountA),
    JSBI.add(normalizeAmount(reserveB), normalizedDepositAmountB),
  ] as const;
  const adjustedBalances = newBalances.map((newBalance, i) => {
    const oldBalance = oldBalances[i] as JSBI;
    const idealBalance = new Fraction(d1, d0).multiply(oldBalance);
    const difference = idealBalance.subtract(newBalance);
    const diffAbs = difference.greaterThan(0)
      ? difference
      : difference.multiply(-1);
    const fee = normalizedTradeFee(
      exchange.fees,
      N_COINS,
      JSBI.BigInt(diffAbs.toFixed(0))
    );
    return JSBI.subtract(newBalance, JSBI.BigInt(fee.toFixed(0)));
  }) as [JSBI, JSBI];
  const d2 = computeD(amp, adjustedBalances[0], adjustedBalances[1]);

  const lpSupply = exchange.lpTotalSupply;
  const mintAmountRaw = JSBI.divide(
    JSBI.multiply(lpSupply.raw, JSBI.subtract(d2, d0)),
    d0
  );

  const mintAmount = new TokenAmount(
    exchange.lpTotalSupply.token,
    mintAmountRaw
  );

  const mintAmountRawBeforeFees = JSBI.divide(
    JSBI.multiply(lpSupply.raw, JSBI.subtract(d1, d0)),
    d0
  );

  const fees = new TokenAmount(
    exchange.lpTotalSupply.token,
    JSBI.subtract(mintAmountRawBeforeFees, mintAmountRaw)
  );
  const mintAmountBeforeFees = new TokenAmount(
    exchange.lpTotalSupply.token,
    mintAmountRawBeforeFees
  );

  return {
    mintAmount,
    mintAmountBeforeFees,
    fees,
  };
};
